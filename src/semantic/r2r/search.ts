/**
 * @file src/semantic/r2r/search.ts
 * @description Degrade-safe R2R retrieval with live-file rehydration. Remote
 * results are accepted only when their document and exact-text hashes map to
 * the active manifest and still match an eligible confined wiki page. R2R
 * therefore ranks candidates but never becomes the source of rendered text.
 */

import type { LoadedProfile } from "../../profile/types.js";
import { loadProfile } from "../../profile/load.js";
import type { PageRecord } from "../../pages/read.js";
import type { SemanticChunkHit, SemanticPageHit } from "../contracts.js";
import { buildEmbeddingText } from "../../utils/embeddings-pages.js";
import { buildNamespaceDirs } from "../../utils/page-registry.js";
import { resolveEligiblePage } from "../../utils/page-resolve.js";
import { slugFromPageId, type PageId } from "../../utils/page-id.js";
import { splitIntoChunks } from "../../utils/retrieval.js";
import { pagePassesRetrievalSurface, type RetrievalSurface } from "../../utils/retrieval-surface.js";
import { R2RClient, type R2RSearchResult } from "./client.js";
import { remoteTextHash } from "./document.js";
import type { R2RManifestPage, R2RManifestUnit } from "./manifest-types.js";
import type { R2RSemanticIndex } from "./types.js";

const MIN_REMOTE_CANDIDATES = 100;
const REMOTE_CANDIDATE_MULTIPLIER = 5;
const MAX_REMOTE_CANDIDATES = 1_000;

/** Live page material needed to verify and rehydrate a remote candidate. */
interface LivePageState {
  record: PageRecord;
  pageTextHash: string;
  chunks: string[];
  chunkHashes: string[];
}

/** Verified remote candidate paired with its active manifest and live page. */
interface VerifiedCandidate {
  result: R2RSearchResult;
  page: R2RManifestPage;
  unit: R2RManifestUnit;
  live: LivePageState;
}

/** Request-scoped data shared while walking R2R's ranked candidate pool. */
interface SearchContext {
  activeByDocument: Map<string, R2RManifestPage>;
  unitsByDocument: Map<string, Map<string, R2RManifestUnit>>;
  namespaceDirs: Map<string, string>;
  liveCache: Map<PageId, Promise<LivePageState | null>>;
  profile: LoadedProfile;
  surface: RetrievalSurface;
}

/** All inputs shared by chunk-level and page-level R2R retrieval. */
interface R2RLookup {
  root: string;
  index: R2RSemanticIndex;
  surface: RetrievalSurface;
  question: string;
  k: number;
  profile?: LoadedProfile;
}

/** One accepted candidate rendered as a caller hit plus its dedupe identity. */
interface ProjectedHit<H> {
  key: string;
  hit: H;
}

/** Retrieve and live-verify R2R body chunks in remote score order. */
export async function findRelevantR2RChunks(
  root: string,
  index: R2RSemanticIndex,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: SemanticChunkHit[]; stalePageIds: PageId[] }> {
  return retrieveWithR2R({ root, index, surface, question, k, profile }, projectChunkCandidate);
}

/** Retrieve page candidates, primarily for pages with no body chunks. */
export async function findRelevantR2RPages(
  root: string,
  index: R2RSemanticIndex,
  surface: RetrievalSurface,
  question: string,
  k: number,
  profile?: LoadedProfile,
): Promise<{ hits: SemanticPageHit[]; stalePageIds: PageId[] }> {
  return retrieveWithR2R({ root, index, surface, question, k, profile }, projectPageCandidate);
}

/** Share remote loading, live prefiltering, freshness walking, and deduping. */
async function retrieveWithR2R<H>(
  lookup: R2RLookup,
  project: (candidate: VerifiedCandidate) => ProjectedHit<H> | null,
): Promise<{ hits: H[]; stalePageIds: PageId[] }> {
  if (lookup.k <= 0) return { hits: [], stalePageIds: [] };
  const [results, profile] = await Promise.all([
    loadRemoteResults(lookup.index, lookup.question, lookup.k),
    lookup.profile ? Promise.resolve(lookup.profile) : loadProfile(lookup.root),
  ]);
  const context = buildSearchContext(lookup.index, lookup.surface, profile);
  return walkResults(lookup.root, results, context, lookup.k, project);
}

/** Fetch an over-complete ranked pool and share it across chunk/page passes. */
async function loadRemoteResults(
  index: R2RSemanticIndex,
  question: string,
  requested: number,
): Promise<R2RSearchResult[]> {
  const limit = candidateLimit(requested);
  if (index.cache.query === question && (index.cache.limit ?? 0) >= limit && index.cache.results) {
    return index.cache.results;
  }
  const results = new R2RClient(index.config).search(question, limit);
  index.cache.query = question;
  index.cache.limit = limit;
  index.cache.results = results;
  return results;
}

/** Bound candidate over-fetching used to backfill stale or opted-out results. */
function candidateLimit(requested: number): number {
  return Math.min(MAX_REMOTE_CANDIDATES, Math.max(MIN_REMOTE_CANDIDATES, requested * REMOTE_CANDIDATE_MULTIPLIER));
}

/** Build a cheap manifest map; individual ranked candidates are verified lazily. */
function buildSearchContext(
  index: R2RSemanticIndex,
  surface: RetrievalSurface,
  profile: LoadedProfile,
): SearchContext {
  const namespaceDirs = buildNamespaceDirs(profile?.profile);
  const pages = index.manifest.pages.filter((page) =>
    pagePassesRetrievalSurface(page.pageId, surface, profile),
  );
  return {
    activeByDocument: new Map(pages.map((page) => [page.documentId, page])),
    unitsByDocument: new Map(),
    namespaceDirs,
    liveCache: new Map(),
    profile,
    surface,
  };
}

/** Walk ranked results until K fresh, distinct projected hits are rehydrated. */
async function walkResults<H>(
  root: string,
  results: R2RSearchResult[],
  context: SearchContext,
  k: number,
  project: (candidate: VerifiedCandidate) => ProjectedHit<H> | null,
): Promise<{ hits: H[]; stalePageIds: PageId[] }> {
  const hits: H[] = [];
  const stale = new Set<PageId>();
  const seen = new Set<string>();
  for (const result of results) {
    if (hits.length >= k) break;
    const candidate = await verifyCandidate(root, result, context, stale);
    const projected = candidate ? project(candidate) : null;
    if (!projected || seen.has(projected.key)) continue;
    seen.add(projected.key);
    hits.push(projected.hit);
  }
  return { hits, stalePageIds: [...stale] };
}

/** Accept a body unit and rehydrate its current local chunk. */
function projectChunkCandidate(candidate: VerifiedCandidate): ProjectedHit<SemanticChunkHit> | null {
  if (candidate.unit.kind !== "chunk") return null;
  return {
    key: `${candidate.page.pageId}#${candidate.unit.chunkIndex}`,
    hit: toChunkHit(candidate, candidate.unit),
  };
}

/** Rehydrate a parent page and dedupe all of its matching remote units. */
function projectPageCandidate(candidate: VerifiedCandidate): ProjectedHit<SemanticPageHit> {
  return { key: candidate.page.pageId, hit: toPageHit(candidate) };
}

/** Map one remote hit to active state and reject any stale hash transition. */
async function verifyCandidate(
  root: string,
  result: R2RSearchResult,
  context: SearchContext,
  stale: Set<PageId>,
): Promise<VerifiedCandidate | null> {
  const page = context.activeByDocument.get(result.documentId);
  if (!page) return null;
  const unit = findManifestUnit(page, remoteTextHash(result.text), context);
  const live = await loadLiveState(root, page.pageId, context);
  if (!unit || !live || !isFresh(page, unit, live)) {
    stale.add(page.pageId);
    return null;
  }
  return { result, page, unit, live };
}

/** Lazily index only candidate pages so repeated hits avoid linear unit scans. */
function findManifestUnit(
  page: R2RManifestPage,
  textHash: string,
  context: SearchContext,
): R2RManifestUnit | undefined {
  let units = context.unitsByDocument.get(page.documentId);
  if (!units) {
    units = new Map();
    for (const unit of page.units) {
      if (!units.has(unit.remoteTextHash)) units.set(unit.remoteTextHash, unit);
    }
    context.unitsByDocument.set(page.documentId, units);
  }
  return units.get(textHash);
}

/** Load and hash a confined live page once for this retrieval operation. */
function loadLiveState(
  root: string,
  pageId: PageId,
  context: SearchContext,
): Promise<LivePageState | null> {
  const cached = context.liveCache.get(pageId);
  if (cached) return cached;
  const loaded = readLiveState(root, pageId, context);
  context.liveCache.set(pageId, loaded);
  return loaded;
}

/** Read one page through the registry and derive current retrieval hashes. */
async function readLiveState(
  root: string,
  pageId: PageId,
  context: SearchContext,
): Promise<LivePageState | null> {
  const resolved = await resolveEligiblePage(
    root,
    pageId,
    context.namespaceDirs,
    context.profile,
    context.surface,
  );
  if (!resolved) return null;
  const { record } = resolved;
  const chunks = splitIntoChunks(record.body);
  return {
    record,
    pageTextHash: remoteTextHash(buildEmbeddingText(record)),
    chunks,
    chunkHashes: chunks.map(remoteTextHash),
  };
}

/** A remote unit is fresh only when every source fragment it contains is live. */
function isFresh(page: R2RManifestPage, unit: R2RManifestUnit, live: LivePageState): boolean {
  if (live.pageTextHash !== page.pageTextHash) return false;
  if (unit.kind === "page") return true;
  return live.chunkHashes[unit.chunkIndex] === unit.contentHash;
}

/** Rehydrate a verified body-chunk result from the current wiki file. */
function toChunkHit(
  candidate: VerifiedCandidate,
  unit: Extract<R2RManifestUnit, { kind: "chunk" }>,
): SemanticChunkHit {
  return {
    pageId: candidate.page.pageId,
    slug: slugFromPageId(candidate.page.pageId),
    chunkIndex: unit.chunkIndex,
    contentHash: unit.contentHash,
    text: candidate.live.chunks[unit.chunkIndex] ?? "",
    score: candidate.result.score,
  };
}

/** Rehydrate a verified page result from current frontmatter. */
function toPageHit(candidate: VerifiedCandidate): SemanticPageHit {
  return {
    pageId: candidate.page.pageId,
    slug: slugFromPageId(candidate.page.pageId),
    title: candidate.live.record.title,
    summary: candidate.live.record.summary,
    score: candidate.result.score,
  };
}

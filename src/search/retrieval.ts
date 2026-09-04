/**
 * Semantic and LLM-based page retrieval for llmwiki (qualified pageId pipeline).
 *
 * Exports `pickSearchRefs`, which resolves relevant pages for a question through
 * the selected semantic read pipeline (chunk-level, then page-level), then
 * falls back to LLM-driven selection over LIVE, surface-eligible,
 * pageId-keyed candidates (NOT the
 * rendered `index.md` — see {@link selectFallbackRefs}). Every hit carries its
 * qualified `pageId`, so a concept `foo` and a query `foo` are distinct, and a
 * typed page surfaces under its `EntityId`. A degraded local or R2R index yields
 * a structured warning instead of silently contributing nothing.
 *
 * `pickSearchSlugs` is the bare-slug compatibility shim (the legacy contract);
 * `loadSelectedRefs` rehydrates refs to full records from the LIVE files via the
 * confined registry loader (never store-cached text — S12).
 */

import {
  loadSemanticReaderForSearch,
  SemanticBackendError,
  type SemanticReader,
  type SemanticWarning,
} from "../semantic/index.js";
import {
  loadSelectedPagesByPageId,
  loadPageRecordPairsByPageId,
  buildNamespaceDirs,
  buildSurfaceEligibleCandidates,
  type SurfaceCandidate,
  type PageRecordWithId,
} from "../utils/page-registry.js";
import type { PageId } from "../utils/page-id.js";
import { loadProfile } from "../profile/load.js";
import { selectPages } from "../commands/page-selection.js";
import { CHUNK_TOP_K, EMBEDDING_TOP_K } from "../utils/constants.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import type { JournalWarning } from "../trust/journal-health-warning.js";

/**
 * A warning surfaced on a search result: a semantic-degrade signal OR the
 * shared journal-health warning (`incomplete-compile` / `journal-unavailable`).
 * The two share a `{ code, message }` shape; a healthy, fully-compiled project
 * surfaces neither, so the default search warnings list stays empty.
 */
export type SearchWarning = SemanticWarning | JournalWarning;

/** A selected page reference carrying its qualified identity plus derived slug. */
export interface SelectedPageRef {
  pageId: PageId;
  slug: string;
  title: string;
  /** Whether the ref came from chunk-level, page-level, or index selection. */
  kind: "chunk" | "page" | "index";
}

/** Outcome of a search: ordered refs plus any degrade warnings (S6). */
export interface SearchSelection {
  refs: SelectedPageRef[];
  warnings: SearchWarning[];
}

/** Deduplicate refs by pageId, preserving first-seen ordering. */
function dedupeRefs(refs: SelectedPageRef[]): SelectedPageRef[] {
  const seen = new Set<PageId>();
  const out: SelectedPageRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.pageId)) continue;
    seen.add(ref.pageId);
    out.push(ref);
  }
  return out;
}

/**
 * Resolve search candidates through the selected backend. Tries chunk-level retrieval
 * first (highest precision), then page-level ranking, then LLM-driven index
 * selection. Carries forward any degrade warning from the semantic load.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query used to rank pages.
 * @returns Ordered refs (pageId-keyed) plus structured warnings.
 */
export async function pickSearchRefs(root: string, question: string): Promise<SearchSelection> {
  const profile = await loadProfile(root);
  const outcome = await loadSemanticReaderForSearch(root);
  // A pending/unavailable compile journal applies to the whole result regardless
  // of which retrieval branch wins, so prepend it to the base warnings ONCE. An
  // ok journal contributes nothing, so the default warnings list is unchanged.
  const journalWarning = await journalHealthWarning(root);
  const base: SearchWarning[] = journalWarning ? [journalWarning, ...outcome.warnings] : outcome.warnings;
  let warnings = base;
  if (outcome.reader) {
    try {
      const semantic = await selectViaSemanticReader(outcome.reader, question, profile);
      warnings = withStaleWarning(base, semantic.stalePageIds);
      if (semantic.refs.length > 0) return { refs: dedupeRefs(semantic.refs), warnings };
    } catch (error) {
      if (!(error instanceof SemanticBackendError)) throw error;
      warnings = withSemanticErrorWarning(base, error);
    }
  }
  const { refs } = await selectFallbackRefs(root, question, "search", profile);
  return { refs, warnings };
}

/** Outcome of semantic selection: ordered refs plus ids dropped for staleness. */
interface SemanticSelection {
  refs: SelectedPageRef[];
  stalePageIds: PageId[];
}

/**
 * Append an `embedding-entry-stale` warning when the read pipeline dropped any
 * index entry as stale (not-live / hash-mismatched). A read-path signal only — the index is
 * repaired on the next compile, never mutated here.
 */
export function withStaleWarning(base: SearchWarning[], stalePageIds: PageId[]): SearchWarning[] {
  if (stalePageIds.length === 0) return base;
  return [
    ...base,
    {
      code: "embedding-entry-stale",
      message: "Some semantic index entries are stale (their page changed or was removed); rebuild with 'llmwiki compile'.",
    },
  ];
}

/** Append a stable, backend-neutral warning for a classified retrieval failure. */
export function withSemanticErrorWarning(
  base: SearchWarning[],
  error: SemanticBackendError,
): SearchWarning[] {
  return [
    ...base,
    {
      code: error.code,
      message: semanticErrorMessage(error),
    },
  ];
}

/** Keep public fallback messages stable while preserving the actionable error code. */
function semanticErrorMessage(error: SemanticBackendError): string {
  if (error.code === "query-embedding-unavailable") {
    return "Could not embed the query; falling back to live page selection.";
  }
  if (error.code === "semantic-retrieval-error") {
    return "Semantic retrieval failed unexpectedly; falling back to live page selection.";
  }
  return "Semantic retrieval is unavailable; falling back to live page selection.";
}

/** Run the chunk-then-page pipeline against a loaded semantic index. */
async function selectViaSemanticReader(
  reader: SemanticReader,
  question: string,
  profile: LoadedProfile,
): Promise<SemanticSelection> {
  const { hits: chunkHits, stalePageIds: chunkStale } =
    await reader.searchChunks({ question, k: CHUNK_TOP_K, profile });
  if (chunkHits.length > 0) {
    const refs = chunkHits.map((c) => ({ pageId: c.pageId, slug: c.slug, title: "", kind: "chunk" as const }));
    return { refs, stalePageIds: chunkStale };
  }
  const { hits: pageHits, stalePageIds: pageStale } =
    await reader.searchPages({ question, k: EMBEDDING_TOP_K, profile });
  const refs = pageHits.map((p) => ({ pageId: p.pageId, slug: p.slug, title: p.title, kind: "page" as const }));
  return { refs, stalePageIds: pageStale };
}

/** Render a surface candidate as a selector bullet keyed by its QUALIFIED pageId. */
function renderCandidate(candidate: SurfaceCandidate): string {
  return `- **${candidate.pageId}**: ${candidate.title} — ${candidate.summary}`;
}

/**
 * LLM fallback selection over LIVE surface-eligible candidates (NOT the rendered
 * index): opted-out/both-false typed pages are never enumerated (privacy), and
 * each candidate is keyed by its qualified pageId so picks resolve to the right
 * namespace (a saved query → queries/<slug>, a typed page → <type>/<slug>) and
 * same-slug pages never collapse.
 *
 * A returned token that is not a KNOWN candidate pageId is dropped — never
 * fabricated into `concepts/<token>` (the old leak/mis-key bug).
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query the model selects pages for.
 * @param surface - Retrieval surface whose flag gates typed candidates.
 * @param profile - Active loaded profile (entity types + directories).
 * @returns Resolved pageId-keyed refs plus the model's reasoning.
 */
export async function selectFallbackRefs(
  root: string,
  question: string,
  surface: "search" | "context",
  profile: LoadedProfile,
): Promise<{ refs: SelectedPageRef[]; reasoning: string }> {
  const namespaces = ["concepts", "queries", ...Object.keys(profile.profile.entities)];
  const dirs = buildNamespaceDirs(profile.profile);
  const candidates = await buildSurfaceEligibleCandidates(root, surface, namespaces, dirs, profile);
  if (candidates.length === 0) {
    return { refs: [], reasoning: "No eligible pages." };
  }
  const rendered = candidates.map(renderCandidate).join("\n");
  const { pages, reasoning } = await selectPages(question, rendered);
  const byPageId = new Map(candidates.map((c) => [c.pageId, c]));
  const refs = pages
    .map((token) => byPageId.get(token))
    .filter((c): c is SurfaceCandidate => c !== undefined)
    .map((c) => ({ pageId: c.pageId, slug: c.slug, title: c.title, kind: "index" as const }));
  return { refs, reasoning };
}

/**
 * Resolve relevant page slugs for a question — the bare-slug compatibility shim.
 * Internally runs the v3 pipeline and projects each ref to its slug, preserving
 * the legacy `string[]` return contract.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param question - The query used to rank pages.
 * @returns Ordered list of relevant page slugs.
 */
export async function pickSearchSlugs(root: string, question: string): Promise<string[]> {
  const { refs } = await pickSearchRefs(root, question);
  return refs.map((ref) => ref.slug);
}

/**
 * Load full content for selected refs from the LIVE files via the confined
 * registry loader (S12 — never store-cached text), skipping any that resolve to
 * an absent / out-of-tree page.
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param refs - Selected page refs to hydrate.
 * @returns Populated page records for all found pages.
 */
export async function loadSelectedRefs(root: string, refs: SelectedPageRef[]): Promise<PageRecord[]> {
  const profile = await loadProfile(root);
  const namespaceDirs = buildNamespaceDirs(profile.profile);
  return loadSelectedPagesByPageId(root, refs.map((r) => r.pageId), namespaceDirs);
}

/**
 * Like {@link loadSelectedRefs}, but pair each hydrated record with the qualified
 * `pageId` it came from (same confined read, same absent/out-of-tree dropping).
 * Used by the answer-grounding path so each page renders under its namespaced id
 * (a `concepts/foo` and a `papers/foo` stay distinguishable to the answer LLM).
 *
 * @param root - Absolute path to the wiki workspace root.
 * @param refs - Selected page refs to hydrate.
 * @returns `{pageId, record}` pairs for all found pages.
 */
export async function loadSelectedRefRecords(root: string, refs: SelectedPageRef[]): Promise<PageRecordWithId[]> {
  const profile = await loadProfile(root);
  const namespaceDirs = buildNamespaceDirs(profile.profile);
  return loadPageRecordPairsByPageId(root, refs.map((r) => r.pageId), namespaceDirs);
}

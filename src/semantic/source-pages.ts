/**
 * @file src/semantic/source-pages.ts
 * @description Backend-neutral eligible-live-page assembly for semantic
 * adapters. It centralizes privacy, profile validity, chunking, and freshness
 * hashes so local embeddings, R2R, and future backends index the same corpus.
 *
 * Produces the `SemanticSourcePage[]` adapters feed into both migration
 * ({@link EligibleLivePage}) and the re-embed pass: every page that is live on
 * disk, passes its embedding-eligibility predicate ({@link pageEmbedSurfaces}),
 * and — for typed pages — is profile-VALID. A both-false typed page (neither
 * search nor context) is NEVER collected, so it is never sent to the provider.
 *
 * Sources:
 *  - concepts/queries — via the confined {@link collectPageRecords}; both
 *    surfaces always eligible (subject to the legacy orphaned/untitled gate).
 *  - typed entity pages — via {@link collectEntityPages}; keyed by their branded
 *    `EntityId`, gated by the entity type's `RetrievalDef` and profile validity.
 *    A symlinked-escaping typed page is dropped by the collector before its
 *    bytes are read.
 *
 * Each collected page carries its retrieval text + live `embeddingTextHash` /
 * `chunkContentHashes` (computed with the SAME `hashChunkText` the store uses),
 * so the migration can content-verify a preserved vector without re-reading.
 */

import { collectNamespacedPageRecords, buildEmbeddingText } from "../utils/embeddings-pages.js";
import { hashChunkText, splitIntoChunks } from "../utils/retrieval.js";
import { qualifiedPageId, type PageId } from "../utils/page-id.js";
import { pageEmbedSurfaces } from "../utils/embed-eligibility.js";
import { collectEntityPages, invalidEntityPagePaths } from "../profile/collect.js";
import { isDefaultProfile } from "../profile/default.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";
import { buildNamespaceDirs } from "../utils/page-registry.js";
import { resolveEligiblePage } from "../utils/page-resolve.js";

/** An eligible live page plus the material the re-embed pass needs. */
export interface SemanticSourcePage {
  /** Qualified page identity shared across every semantic backend. */
  pageId: PageId;
  /** Filename-derived slug retained for local store compatibility. */
  bareSlug: string;
  /** Hash of the page-level title/summary embedding text. */
  embeddingTextHash: string;
  /** Ordered hashes corresponding exactly to `chunkTexts`. */
  chunkContentHashes: string[];
  /** The page's title, included in the page-level semantic representation. */
  title: string;
  /** The page's summary — part of the embedding text. */
  summary: string;
  /** The page body, already split into chunk texts (one per `chunkContentHashes`). */
  chunkTexts: string[];
  /** The exact text passed to the provider for the page-level embedding. */
  embeddingText: string;
}

/**
 * Collect every eligible, valid, live page across reserved + typed namespaces.
 * The result is keyed by qualified `pageId`; a both-false or profile-invalid
 * typed page is omitted entirely (never indexed — S2 privacy).
 *
 * @param root - Project root path.
 * @param profile - The resolved profile (default → only concepts/queries).
 * @returns Collected pages with retrieval text + live hashes.
 */
export async function collectEligibleLivePages(
  root: string,
  profile: LoadedProfile,
): Promise<SemanticSourcePage[]> {
  const reserved = await collectReservedPages(root);
  if (isDefaultProfile(profile.profile)) return reserved;
  const typed = await collectTypedPages(root, profile);
  return [...reserved, ...typed];
}

/**
 * Collect only explicitly changed qualified ids through direct confined reads.
 * Missing or newly ineligible ids are omitted so incremental backends can treat
 * their prior documents as deletions without scanning the entire corpus.
 */
export async function collectEligibleLivePagesById(
  root: string,
  pageIds: PageId[],
  profile: LoadedProfile,
): Promise<SemanticSourcePage[]> {
  const namespaceDirs = buildNamespaceDirs(profile.profile);
  const collected: SemanticSourcePage[] = [];
  for (const pageId of new Set(pageIds)) {
    const resolved = await resolveEligiblePage(root, pageId, namespaceDirs, profile);
    if (resolved) collected.push(toCollectedPage(pageId, resolved.record));
  }
  return collected;
}

/** Collect concept + query pages (both surfaces eligible, legacy gate applies). */
async function collectReservedPages(root: string): Promise<SemanticSourcePage[]> {
  const tagged = await collectNamespacedPageRecords(root);
  return tagged.map(({ namespace, record }) =>
    toCollectedPage(qualifiedPageId(namespace, record.slug), record),
  );
}

/** Collect typed entity pages, gated by eligibility + profile validity. */
async function collectTypedPages(root: string, profile: LoadedProfile): Promise<SemanticSourcePage[]> {
  const { pages, problems } = await collectEntityPages(root, profile.profile);
  const invalidPaths = invalidEntityPagePaths(problems);
  const out: SemanticSourcePage[] = [];
  for (const page of pages) {
    const retrieval = profile.profile.entities[page.entityType]?.retrieval;
    const isProfileInvalid = invalidPaths.has(page.filePath);
    const surfaces = pageEmbedSurfaces({ meta: page.frontmatter, pageKind: "typed", retrieval, isProfileInvalid });
    if (!surfaces.embedded) continue;
    const record: PageRecord = {
      slug: page.slug,
      title: page.title ?? page.slug,
      summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
      body: page.body.trim(),
    };
    out.push(toCollectedPage(qualifiedPageId(page.entityType, page.slug), record));
  }
  return out;
}

/** Build a {@link SemanticSourcePage} from a pageId and live record. */
function toCollectedPage(pageId: PageId, record: PageRecord): SemanticSourcePage {
  const embeddingText = buildEmbeddingText(record);
  const chunkTexts = splitIntoChunks(record.body);
  return {
    pageId,
    bareSlug: record.slug,
    embeddingTextHash: hashChunkText(embeddingText),
    chunkContentHashes: chunkTexts.map(hashChunkText),
    title: record.title,
    summary: record.summary,
    chunkTexts,
    embeddingText,
  };
}

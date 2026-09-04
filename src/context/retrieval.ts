/**
 * Semantic retrieval wrapper for `llmwiki context` (qualified pageId pipeline).
 *
 * Wraps the backend-neutral read pipeline so the orchestrator never has to
 * special-case local provider failures, missing stores, R2R outages, or stale
 * entries. Semantic retrieval is opportunistic: context packs keep working on
 * lexical signals alone. Each failure mode maps to a stable warning code.
 *
 * Local v3 compatibility warning codes remain stable. R2R configuration and
 * network failures surface as backend warnings. Every hit carries a qualified
 * `pageId`, and ranking resolves it via `findPageByQualifiedId`.
 */

import {
  loadSemanticReaderForContext,
  SemanticBackendError,
  type SemanticChunkHit as BackendChunkHit,
} from "../semantic/index.js";
import { loadProfile } from "../profile/load.js";
import { CHUNK_TOP_K } from "../utils/constants.js";

/** Stable warning code returned when semantic retrieval did not contribute. */
export type SemanticRetrievalWarning =
  | "embedding-store-missing"
  | "embedding-index-outdated"
  | "query-embedding-unavailable"
  | "semantic-backend-unavailable"
  | "semantic-retrieval-error";

/**
 * Slimmed chunk record passed from retrieval into ranking. Keeps `ranking.ts`
 * independent of the underlying embedding-store shape. Carries the qualified
 * `pageId` so ranking resolves it via `findPageByQualifiedId` (a concept `foo`
 * and a query `foo` stay distinct), plus the bare `slug` for display.
 */
export interface SemanticChunkHit {
  /** Qualified page id (`<namespace>/<page-part>`) — resolved in ranking. */
  pageId: string;
  /** Bare page slug (page-part) for display/grouping. */
  slug: string;
  /** Chunk body text — surfaced verbatim in `primary[].chunks[].text`. */
  text: string;
  /** Similarity score supplied by the selected semantic backend. */
  score: number;
  /** Live content hash of the chunk text; pass-through into the chunk entry. */
  contentHash: string;
}

/**
 * Outcome of one semantic retrieval call. Either `hits` is populated and
 * `warning` is `null`, or `hits` is empty and `warning` carries the stable code.
 *
 * `staleEntriesDetected` is an INDEPENDENT signal (it co-occurs with hits): the
 * read pipeline dropped at least one store entry as stale this call. It maps to
 * a top-level `embedding-entry-stale` warning, mirroring `embedding-index-outdated`
 * — a read-path signal only; the store is repaired on the next compile.
 */
export interface SemanticRetrievalOutcome {
  hits: SemanticChunkHit[];
  warning: SemanticRetrievalWarning | null;
  staleEntriesDetected: boolean;
}

/**
 * Best-effort retrieval over the selected semantic index. Returns its top-k
 * verified chunks for `prompt`, OR a warning explaining why
 * semantic retrieval contributed nothing this call.
 *
 * @param root - Project root path.
 * @param prompt - The ranking prompt (NOT the truncated display copy).
 * @param topChunks - Maximum chunks to retrieve (≤ 0 → no-op).
 */
export async function retrieveSemanticChunks(
  root: string,
  prompt: string,
  topChunks: number,
): Promise<SemanticRetrievalOutcome> {
  if (topChunks <= 0) return emptyOutcome(null);
  const outcome = await loadSemanticReaderForContext(root);
  if (!outcome.reader) return emptyOutcome(mapLoadWarning(outcome.warnings[0]?.code));

  try {
    const k = Math.min(topChunks, CHUNK_TOP_K);
    const profile = await loadProfile(root);
    const { hits, stalePageIds } = await outcome.reader.searchChunks({ question: prompt, k, profile });
    const staleEntriesDetected = stalePageIds.length > 0;
    if (hits.length === 0) return emptyOutcome("embedding-store-missing", staleEntriesDetected);
    return { hits: hits.map(toSemanticChunkHit), warning: null, staleEntriesDetected };
  } catch (err) {
    return emptyOutcome(classifyRetrievalError(err));
  }
}

/** Build the empty-hits outcome shape; centralised to keep callers terse. */
function emptyOutcome(
  warning: SemanticRetrievalWarning | null,
  staleEntriesDetected = false,
): SemanticRetrievalOutcome {
  return { hits: [], warning, staleEntriesDetected };
}

/** Map a loader degrade warning code onto the context retrieval warning vocabulary. */
function mapLoadWarning(code: string | undefined): SemanticRetrievalWarning {
  if (code === "embedding-index-outdated" || code === "semantic-index-outdated") {
    return "embedding-index-outdated";
  }
  if (code === "semantic-backend-unavailable") return "semantic-backend-unavailable";
  return "embedding-store-missing";
}

/** Classify failures without leaking raw provider or stack text into JSON. */
function classifyRetrievalError(err: unknown): SemanticRetrievalWarning {
  return err instanceof SemanticBackendError ? err.code : "semantic-retrieval-error";
}

/** Project a v3 chunk hit onto the ranking-facing shape. */
function toSemanticChunkHit(hit: BackendChunkHit): SemanticChunkHit {
  return {
    pageId: hit.pageId,
    slug: hit.slug,
    text: hit.text,
    score: hit.score,
    contentHash: hit.contentHash,
  };
}

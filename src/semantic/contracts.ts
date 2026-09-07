/**
 * @file src/semantic/contracts.ts
 * @description Public, backend-neutral contracts for semantic indexing and
 * retrieval. A backend binds storage and connection details while consumers see
 * only a reader, normalized hits, capabilities, and typed failure information.
 */

import type { LoadedProfile } from "../profile/types.js";
import type { PageId } from "../utils/page-id.js";
import type { RetrievalSurface } from "../utils/retrieval-surface.js";

/** Stable warning emitted when semantic retrieval cannot be used completely. */
export interface SemanticWarning {
  code:
    | "embedding-index-outdated"
    | "embedding-store-unavailable"
    | "embedding-entry-stale"
    | "semantic-index-outdated"
    | "semantic-backend-unavailable"
    | "query-embedding-unavailable"
    | "semantic-retrieval-error";
  message: string;
}

/** Backend-independent chunk result, always rehydrated from trusted local text. */
export interface SemanticChunkHit {
  pageId: PageId;
  slug: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  score: number;
}

/** Backend-independent page result, always rehydrated from trusted local state. */
export interface SemanticPageHit {
  pageId: PageId;
  slug: string;
  title: string;
  summary: string;
  score: number;
}

/** Inputs shared by chunk and page searches on a surface-bound reader. */
export interface SemanticSearchRequest {
  question: string;
  k: number;
  profile?: LoadedProfile;
}

/** Search result plus local pages rejected because the index was stale. */
export interface SemanticSearchOutcome<Hit> {
  hits: Hit[];
  stalePageIds: PageId[];
}

/** Loaded retrieval handle. Its implementation remains private to the adapter. */
export interface SemanticReader {
  searchChunks(request: SemanticSearchRequest): Promise<SemanticSearchOutcome<SemanticChunkHit>>;
  searchPages(request: SemanticSearchRequest): Promise<SemanticSearchOutcome<SemanticPageHit>>;
}

/** Inputs supplied to a backend when a read handle is requested. */
export interface SemanticLoadRequest {
  root: string;
  surface: RetrievalSurface;
}

/** Degrade-aware semantic reader load result. */
export interface SemanticLoadOutcome {
  reader: SemanticReader | null;
  warnings: SemanticWarning[];
  stalePageIds: PageId[];
}

/** One page-specific reconciliation failure. */
export interface SemanticSyncFailure {
  pageId?: PageId;
  operation: "ingest" | "delete";
  message: string;
}

/** Backend-neutral result used by the durable pending-index lifecycle. */
export interface SemanticSyncOutcome {
  indexed: PageId[];
  eligible: PageId[];
  failures: SemanticSyncFailure[];
}

/** Inputs supplied while the caller owns the project write lock. */
export interface SemanticSyncRequest {
  root: string;
  changedPageIds: PageId[];
}

/** Behavioral flags consumed without naming a concrete backend. */
export interface SemanticBackendCapabilities {
  needsLocalEmbeddingProvider: boolean;
  reconcileWhenIdle: boolean;
}

/** Operations used to classify a backend error consistently. */
export type SemanticOperation = "load" | "search" | "sync";

/** Stable retrieval error categories understood by backend-neutral consumers. */
export type SemanticBackendErrorCode =
  | "query-embedding-unavailable"
  | "semantic-backend-unavailable"
  | "semantic-retrieval-error";

/** Typed, bounded semantic failure safe to expose without backend branching. */
export class SemanticBackendError extends Error {
  constructor(
    public readonly backendId: string,
    public readonly code: SemanticBackendErrorCode,
    public readonly safeMessage: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(safeMessage, options);
    this.name = "SemanticBackendError";
  }
}

/** Pluggable semantic backend contract used by both built-ins and SDK hosts. */
export interface SemanticBackend {
  readonly id: string;
  readonly capabilities: Readonly<SemanticBackendCapabilities>;
  load(request: SemanticLoadRequest): Promise<SemanticLoadOutcome>;
  sync(request: SemanticSyncRequest): Promise<SemanticSyncOutcome>;
  classifyError(error: unknown, operation: SemanticOperation): SemanticBackendError;
}

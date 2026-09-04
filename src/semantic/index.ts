/**
 * @file src/semantic/index.ts
 * @description Stable barrel for the modular semantic subsystem. Consumer code
 * imports contracts and application-service functions here; concrete adapters
 * remain isolated in `local/` and `r2r/`.
 */

export {
  SemanticBackendError,
} from "./contracts.js";

export type {
  SemanticChunkHit,
  SemanticReader,
  SemanticSyncOutcome,
  SemanticWarning,
} from "./contracts.js";

export {
  assertSemanticSyncSucceeded,
  loadSemanticReaderForContext,
  loadSemanticReaderForSearch,
  needsLocalEmbeddingProvider,
  refreshSemanticIndexLockedCore,
  shouldReconcileSemanticIndexWhenIdle,
} from "./service.js";

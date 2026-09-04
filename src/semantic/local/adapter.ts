/**
 * @file src/semantic/local/adapter.ts
 * @description Adapter for the built-in embeddings.json implementation. It
 * contains every dependency on the local store shape and exposes only the
 * shared semantic backend contract to registry and consumers.
 */

import {
  findRelevantChunksV3,
  findRelevantPagesV3,
  loadEmbeddingsForContext,
  loadEmbeddingsForSearch,
} from "../../utils/embeddings-load.js";
import type { EmbeddingStoreV3 } from "../../utils/embeddings-store.js";
import { updateEmbeddingsLockedCore } from "../../utils/embeddings.js";
import type {
  SemanticBackend,
  SemanticLoadRequest,
  SemanticOperation,
  SemanticReader,
  SemanticSearchRequest,
} from "../contracts.js";
import { SemanticBackendError } from "../contracts.js";
import { boundedErrorMessage, looksLikeEmbeddingProviderFailure } from "../error.js";

const LOCAL_BACKEND_ID = "local";

/** Built-in local semantic adapter. */
export const localSemanticBackend: SemanticBackend = {
  id: LOCAL_BACKEND_ID,
  capabilities: Object.freeze({
    needsLocalEmbeddingProvider: true,
    reconcileWhenIdle: false,
  }),
  load: loadLocalReader,
  sync: async ({ root, changedPageIds }) => {
    const outcome = await updateEmbeddingsLockedCore(root, changedPageIds);
    return { indexed: outcome.embedded, eligible: outcome.eligible, failures: [] };
  },
  classifyError: classifyLocalError,
};

/** Load and bind an embeddings.json store to one root and retrieval surface. */
async function loadLocalReader(request: SemanticLoadRequest) {
  const loaded = request.surface === "search"
    ? await loadEmbeddingsForSearch(request.root)
    : await loadEmbeddingsForContext(request.root);
  return {
    reader: loaded.store ? createLocalReader(request, loaded.store) : null,
    warnings: loaded.warnings,
    stalePageIds: loaded.stalePageIds,
  };
}

/** Hide the concrete store inside a backend-neutral reader. */
function createLocalReader(
  request: SemanticLoadRequest,
  store: EmbeddingStoreV3,
): SemanticReader {
  return {
    searchChunks: (search) => searchLocalChunks(request, store, search),
    searchPages: (search) => searchLocalPages(request, store, search),
  };
}

/** Delegate chunk lookup to the mature v3 local pipeline. */
function searchLocalChunks(
  load: SemanticLoadRequest,
  store: EmbeddingStoreV3,
  search: SemanticSearchRequest,
) {
  return findRelevantChunksV3(
    load.root,
    store,
    load.surface,
    search.question,
    search.k,
    search.profile,
  );
}

/** Delegate page lookup to the mature v3 local pipeline. */
function searchLocalPages(
  load: SemanticLoadRequest,
  store: EmbeddingStoreV3,
  search: SemanticSearchRequest,
) {
  return findRelevantPagesV3(
    load.root,
    store,
    load.surface,
    search.question,
    search.k,
    search.profile,
  );
}

/** Convert local provider and retrieval errors to stable shared categories. */
function classifyLocalError(error: unknown, operation: SemanticOperation): SemanticBackendError {
  const providerFailure = operation === "search" && looksLikeEmbeddingProviderFailure(error);
  return new SemanticBackendError(
    LOCAL_BACKEND_ID,
    providerFailure ? "query-embedding-unavailable" : "semantic-retrieval-error",
    boundedErrorMessage(error),
    providerFailure,
    error instanceof Error ? { cause: error } : undefined,
  );
}

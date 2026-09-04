/**
 * @file src/semantic/r2r/adapter.ts
 * @description R2R implementation of the shared semantic backend contract.
 * Configuration, manifests, HTTP calls, remote caches, and reconciliation are
 * contained here and below this directory rather than leaking into consumers.
 */

import type {
  SemanticBackend,
  SemanticLoadRequest,
  SemanticReader,
  SemanticSearchRequest,
} from "../contracts.js";
import { SemanticBackendError } from "../contracts.js";
import { resolveR2RConfig } from "./config.js";
import { readR2RManifest } from "./manifest.js";
import { findRelevantR2RChunks, findRelevantR2RPages } from "./search.js";
import { syncR2RIndex } from "./sync.js";
import type { R2RSemanticIndex } from "./types.js";

const R2R_BACKEND_ID = "r2r";

/** Built-in remote R2R adapter. */
export const r2rSemanticBackend: SemanticBackend = {
  id: R2R_BACKEND_ID,
  capabilities: Object.freeze({
    needsLocalEmbeddingProvider: false,
    reconcileWhenIdle: true,
  }),
  load: loadR2RReader,
  sync: ({ root, changedPageIds }) => syncR2RIndex(root, changedPageIds, resolveR2RConfig()),
  classifyError: (error, operation) => new SemanticBackendError(
    R2R_BACKEND_ID,
    "semantic-backend-unavailable",
    `R2R semantic backend unavailable during ${operation}.`,
    true,
    error instanceof Error ? { cause: error } : undefined,
  ),
};

/** Load the text-free manifest that anchors trusted remote-result mapping. */
async function loadR2RReader(request: SemanticLoadRequest) {
  const config = resolveR2RConfig();
  const read = await readR2RManifest(request.root, config);
  if (read.kind === "absent") {
    return degraded("semantic-index-outdated", "No R2R semantic index found; rebuild with 'llmwiki compile'.");
  }
  if (read.kind === "unavailable") {
    return degraded("semantic-backend-unavailable", "R2R semantic manifest failed integrity validation.");
  }
  const index: R2RSemanticIndex = { config, manifest: read.manifest, cache: {} };
  return { reader: createR2RReader(request, index), warnings: [], stalePageIds: [] };
}

/** Bind R2R implementation state inside a backend-neutral reader. */
function createR2RReader(
  request: SemanticLoadRequest,
  index: R2RSemanticIndex,
): SemanticReader {
  return {
    searchChunks: (search) => searchR2RChunks(request, index, search),
    searchPages: (search) => searchR2RPages(request, index, search),
  };
}

/** Route a chunk request while retaining adapter-private state. */
function searchR2RChunks(
  load: SemanticLoadRequest,
  index: R2RSemanticIndex,
  search: SemanticSearchRequest,
) {
  return findRelevantR2RChunks(
    load.root,
    index,
    load.surface,
    search.question,
    search.k,
    search.profile,
  );
}

/** Route a page request while retaining adapter-private state. */
function searchR2RPages(
  load: SemanticLoadRequest,
  index: R2RSemanticIndex,
  search: SemanticSearchRequest,
) {
  return findRelevantR2RPages(
    load.root,
    index,
    load.surface,
    search.question,
    search.k,
    search.profile,
  );
}

/** Build a null-reader outcome for unavailable or missing R2R state. */
function degraded(code: "semantic-index-outdated" | "semantic-backend-unavailable", message: string) {
  return { reader: null, warnings: [{ code, message }], stalePageIds: [] };
}

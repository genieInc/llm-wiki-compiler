/**
 * @file src/semantic/r2r/adapter.ts
 * @description R2R implementation and public factory for the shared semantic
 * backend contract. Each factory instance closes over an immutable config or
 * a root-aware resolver, so concurrent tenants never share mutable routing.
 */

import type {
  SemanticBackend,
  SemanticLoadRequest,
  SemanticReader,
  SemanticSearchRequest,
} from "../contracts.js";
import { SemanticBackendError } from "../contracts.js";
import {
  resolveR2RConfig,
  resolveR2RConfigOptions,
  type R2RConfig,
  type R2RSemanticBackendOptions,
  type R2RSemanticBackendResolver,
} from "./config.js";
import { readR2RManifest } from "./manifest.js";
import { findRelevantR2RChunks, findRelevantR2RPages } from "./search.js";
import { syncR2RIndex } from "./sync.js";
import type { R2RSemanticIndex } from "./types.js";

const R2R_BACKEND_ID = "r2r";
type R2RConfigProvider = (root: string) => Promise<R2RConfig>;

/**
 * Create an environment-independent R2R semantic backend.
 *
 * Static options are validated and snapshotted immediately. A resolver is
 * called for each load or sync and may safely route concurrent roots to
 * distinct collections, namespaces, projects, and credentials.
 *
 * @param source - Static options or a trusted root-aware binding resolver.
 * @returns A state-free adapter suitable for `createWiki({ semanticBackend })`.
 */
export function createR2RSemanticBackend(
  source: R2RSemanticBackendOptions | R2RSemanticBackendResolver,
): SemanticBackend {
  return buildR2RSemanticBackend(createConfigProvider(source));
}

/** Built-in CLI adapter; environment resolution stays lazy for each operation. */
export const r2rSemanticBackend = buildR2RSemanticBackend(
  async () => resolveR2RConfig(),
);

/** Build the state-free adapter around one configuration provider. */
function buildR2RSemanticBackend(resolveConfig: R2RConfigProvider): SemanticBackend {
  return {
    id: R2R_BACKEND_ID,
    capabilities: Object.freeze({
      needsLocalEmbeddingProvider: false,
      reconcileWhenIdle: true,
    }),
    load: async (request) => loadR2RReader(request, await resolveConfig(request.root)),
    sync: async ({ root, changedPageIds }) => syncR2RIndex(
      root,
      changedPageIds,
      await resolveConfig(root),
    ),
    classifyError: classifyR2RError,
  };
}

/** Snapshot static settings eagerly or validate every dynamic tenant result. */
function createConfigProvider(
  source: R2RSemanticBackendOptions | R2RSemanticBackendResolver,
): R2RConfigProvider {
  if (typeof source === "function") {
    return async (root) => resolveR2RConfigOptions(
      await source(Object.freeze({ root })),
    );
  }
  const config = resolveR2RConfigOptions(source);
  return async () => config;
}

/** Hide raw resolver, transport, and server errors behind the shared boundary. */
function classifyR2RError(error: unknown, operation: Parameters<SemanticBackend["classifyError"]>[1]) {
  return new SemanticBackendError(
    R2R_BACKEND_ID,
    "semantic-backend-unavailable",
    `R2R semantic backend unavailable during ${operation}.`,
    true,
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** Load the text-free manifest that anchors trusted remote-result mapping. */
async function loadR2RReader(request: SemanticLoadRequest, config: R2RConfig) {
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

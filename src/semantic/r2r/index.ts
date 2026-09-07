/**
 * @file src/semantic/r2r/index.ts
 * @description Public, experimental R2R adapter surface. Hosts can bind a
 * static configuration per Wiki or provide a root-aware async resolver for
 * concurrent multi-tenant routing without process-wide environment mutation.
 */

export { createR2RSemanticBackend } from "./adapter.js";

export type {
  R2RSearchMode,
  R2RSemanticBackendContext,
  R2RSemanticBackendOptions,
  R2RSemanticBackendResolver,
} from "./config.js";

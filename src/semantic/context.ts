/**
 * @file src/semantic/context.ts
 * @description Async-context override for SDK-scoped semantic backends. This
 * keeps concurrent Wiki instances isolated without threading backend arguments
 * through every compiler, search, context, review, and import call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { SemanticBackend } from "./contracts.js";

const semanticBackendContext = new AsyncLocalStorage<SemanticBackend>();

/** Run one async call tree with an explicit semantic backend. */
export function withSemanticBackend<T>(backend: SemanticBackend, fn: () => T): T {
  return semanticBackendContext.run(backend, fn);
}

/** Return the current SDK-scoped backend, if the caller installed one. */
export function semanticBackendOverride(): SemanticBackend | undefined {
  return semanticBackendContext.getStore();
}

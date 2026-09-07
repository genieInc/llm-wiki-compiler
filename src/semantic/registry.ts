/**
 * @file src/semantic/registry.ts
 * @description Single registry for built-in and SDK-supplied semantic backends.
 * Backend selection is validated here, so adding another built-in requires one
 * adapter and one registry entry rather than changes throughout the codebase.
 */

import { resolveSemanticBackendId, SEMANTIC_BACKEND_ENV } from "./config.js";
import { semanticBackendOverride } from "./context.js";
import type { SemanticBackend } from "./contracts.js";
import { localSemanticBackend } from "./local/adapter.js";
import { r2rSemanticBackend } from "./r2r/adapter.js";

const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const BUILTIN_BACKENDS = Object.freeze([localSemanticBackend, r2rSemanticBackend]);
const BACKEND_BY_ID = new Map(BUILTIN_BACKENDS.map((backend) => [backend.id, backend]));

/** Return registered built-ins for help text, validation, and contract tests. */
export function registeredSemanticBackends(): readonly SemanticBackend[] {
  return BUILTIN_BACKENDS;
}

/** Resolve one built-in backend id with a useful fail-closed error. */
function getSemanticBackend(id: string): SemanticBackend {
  const backend = BACKEND_BY_ID.get(id);
  if (backend) return backend;
  const available = BUILTIN_BACKENDS.map((item) => JSON.stringify(item.id)).join(", ");
  throw new Error(`${SEMANTIC_BACKEND_ENV} must name a registered backend (${available}); received ${JSON.stringify(id)}`);
}

/** Resolve an SDK option, validating custom implementations at construction. */
export function resolveSemanticBackend(input?: string | SemanticBackend): SemanticBackend | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return getSemanticBackend(input.trim().toLowerCase());
  assertSemanticBackend(input);
  return input;
}

/** Return the async-scoped SDK backend or the environment-selected built-in. */
export function activeSemanticBackend(): SemanticBackend {
  return semanticBackendOverride() ?? getSemanticBackend(resolveSemanticBackendId());
}

/** Validate the small runtime surface that JavaScript hosts can supply. */
function assertSemanticBackend(value: SemanticBackend): void {
  if (!BACKEND_ID_PATTERN.test(value?.id)) throw new TypeError("semanticBackend.id must be a lowercase backend identifier.");
  if (typeof value.load !== "function" || typeof value.sync !== "function") {
    throw new TypeError("semanticBackend must implement load() and sync().");
  }
  if (typeof value.classifyError !== "function") {
    throw new TypeError("semanticBackend must implement classifyError().");
  }
  const capabilities = value.capabilities;
  if (typeof capabilities?.needsLocalEmbeddingProvider !== "boolean"
    || typeof capabilities.reconcileWhenIdle !== "boolean") {
    throw new TypeError("semanticBackend.capabilities must declare both boolean capabilities.");
  }
}

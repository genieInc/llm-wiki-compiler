/**
 * @file src/semantic/config.ts
 * @description Environment-only selection of the active semantic index backend.
 * Backend-specific connection settings live beside their adapters so adding a
 * provider does not expand this shared selector.
 */

export const SEMANTIC_BACKEND_ENV = "LLMWIKI_SEMANTIC_BACKEND";

/** Resolve the configured backend id; the registry owns availability checks. */
export function resolveSemanticBackendId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[SEMANTIC_BACKEND_ENV]?.trim().toLowerCase() || "local";
}

/**
 * @file src/semantic/service.ts
 * @description Backend-neutral semantic application service. It selects one
 * adapter, guards its opaque reader, applies consistent degradation policy, and
 * exposes capabilities without concrete-backend checks in business logic.
 */

import type { PageId } from "../utils/page-id.js";
import type { RetrievalSurface } from "../utils/retrieval-surface.js";
import type {
  SemanticBackend,
  SemanticLoadOutcome,
  SemanticReader,
  SemanticSearchOutcome,
  SemanticSyncOutcome,
  SemanticWarning,
} from "./contracts.js";
import { SemanticBackendError } from "./contracts.js";
import { activeSemanticBackend } from "./registry.js";
import {
  assertChunkSearchOutcome,
  assertPageSearchOutcome,
  assertSemanticLoadOutcome,
  assertSemanticSyncOutcome,
} from "./validation.js";

const SEMANTIC_ERROR_CODES = new Set([
  "query-embedding-unavailable",
  "semantic-backend-unavailable",
  "semantic-retrieval-error",
]);
const SEMANTIC_ERROR_MESSAGE_MAX_CHARS = 2_000;

/** Load the selected backend for search without mutating its index. */
export function loadSemanticReaderForSearch(root: string): Promise<SemanticLoadOutcome> {
  return loadSemanticReader(root, "search");
}

/** Load the selected backend for context without mutating its index. */
export function loadSemanticReaderForContext(root: string): Promise<SemanticLoadOutcome> {
  return loadSemanticReader(root, "context");
}

/** Load and protect a surface-bound reader, degrading load errors to warnings. */
async function loadSemanticReader(
  root: string,
  surface: RetrievalSurface,
): Promise<SemanticLoadOutcome> {
  const backend = activeSemanticBackend();
  try {
    const outcome: unknown = await backend.load({ root, surface });
    assertSemanticLoadOutcome(outcome);
    return outcome.reader ? { ...outcome, reader: guardReader(outcome.reader, backend) } : outcome;
  } catch (error) {
    const classified = classifyOnce(backend, error, "load");
    return degraded(classified.safeMessage);
  }
}

/** Add typed error classification around opaque adapter reader methods. */
function guardReader(reader: SemanticReader, backend: SemanticBackend): SemanticReader {
  return {
    searchChunks: (request) => guardSearch(
      backend,
      () => reader.searchChunks(request),
      assertChunkSearchOutcome,
    ),
    searchPages: (request) => guardSearch(
      backend,
      () => reader.searchPages(request),
      assertPageSearchOutcome,
    ),
  };
}

/** Preserve already-classified errors and classify all adapter leaks once. */
async function guardSearch<Hit>(
  backend: SemanticBackend,
  search: () => Promise<SemanticSearchOutcome<Hit>>,
  validate: (value: unknown) => asserts value is SemanticSearchOutcome<Hit>,
): Promise<SemanticSearchOutcome<Hit>> {
  try {
    const outcome: unknown = await search();
    validate(outcome);
    return outcome;
  } catch (error) {
    throw classifyOnce(backend, error, "search");
  }
}

/** Reconcile the active backend while the caller owns the project lock. */
export async function refreshSemanticIndexLockedCore(
  root: string,
  changedPageIds: PageId[],
): Promise<SemanticSyncOutcome> {
  const backend = activeSemanticBackend();
  try {
    const outcome: unknown = await backend.sync({ root, changedPageIds });
    assertSemanticSyncOutcome(outcome);
    return outcome;
  } catch (error) {
    throw classifyOnce(backend, error, "sync");
  }
}

/** Whether the active adapter needs llmwiki's embedding-provider guard. */
export function needsLocalEmbeddingProvider(): boolean {
  return activeSemanticBackend().capabilities.needsLocalEmbeddingProvider;
}

/** Whether an empty change set should still invoke backend reconciliation. */
export function shouldReconcileSemanticIndexWhenIdle(): boolean {
  return activeSemanticBackend().capabilities.reconcileWhenIdle;
}

/** Convert partial backend failures into one bounded error for strict paths. */
export function assertSemanticSyncSucceeded(outcome: SemanticSyncOutcome): void {
  if (outcome.failures.length === 0) return;
  const examples = outcome.failures.slice(0, 3).map((failure) => failure.message).join("; ");
  const omitted = outcome.failures.length > 3 ? ` (+${outcome.failures.length - 3} more)` : "";
  throw new Error(`Semantic index refresh had ${outcome.failures.length} failure(s): ${examples}${omitted}`);
}

/** Classify exactly once even if an adapter intentionally throws the shared type. */
function classifyOnce(
  backend: SemanticBackend,
  error: unknown,
  operation: "load" | "search" | "sync",
): SemanticBackendError {
  if (validClassifiedError(error, backend.id)) return error;
  try {
    const classified = backend.classifyError(error, operation);
    if (validClassifiedError(classified, backend.id)) return classified;
  } catch {
    // Fall through to the stable boundary error when a third-party classifier fails.
  }
  return new SemanticBackendError(
    backend.id,
    "semantic-backend-unavailable",
    `Semantic backend ${backend.id} failed during ${operation}.`,
    false,
    error instanceof Error ? { cause: error } : undefined,
  );
}

/** Validate third-party error classification before consumers branch on it. */
function validClassifiedError(error: unknown, backendId: string): error is SemanticBackendError {
  return error instanceof SemanticBackendError
    && error.backendId === backendId
    && SEMANTIC_ERROR_CODES.has(error.code)
    && typeof error.safeMessage === "string"
    && error.safeMessage.length <= SEMANTIC_ERROR_MESSAGE_MAX_CHARS
    && typeof error.retryable === "boolean";
}

/** Build a consistent loader degradation outcome. */
function degraded(message: string): SemanticLoadOutcome {
  const warning: SemanticWarning = {
    code: "semantic-backend-unavailable",
    message: `Semantic backend unavailable: ${message}`,
  };
  return { reader: null, warnings: [warning], stalePageIds: [] };
}

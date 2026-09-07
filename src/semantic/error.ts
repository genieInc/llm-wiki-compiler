/**
 * @file src/semantic/error.ts
 * @description Shared error-sanitization helpers for semantic adapters. They
 * bound arbitrary provider/service messages before those messages cross a CLI,
 * JSON, or SDK boundary and preserve the original error only as a cause.
 */

const MAX_SAFE_MESSAGE_LENGTH = 2_000;

/** Convert an arbitrary thrown value to bounded display text. */
export function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_SAFE_MESSAGE_LENGTH);
}

/** Recognize credential/provider/network failures from local embedding clients. */
export function looksLikeEmbeddingProviderFailure(error: unknown): boolean {
  return /api[_ -]?key|auth|credential|token|provider|voyage|openai|ollama|timeout|fetch|econn|enotfound/i
    .test(boundedErrorMessage(error));
}

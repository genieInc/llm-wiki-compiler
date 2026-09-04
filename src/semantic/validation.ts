/**
 * @file src/semantic/validation.ts
 * @description Runtime guards for the public semantic adapter contract. They
 * turn malformed JavaScript/package adapter results into one boundary failure
 * before incomplete data can leak into search, context, or pending-index state.
 */

import { parseQualifiedPageId } from "../utils/page-id.js";
import type {
  SemanticChunkHit,
  SemanticLoadOutcome,
  SemanticPageHit,
  SemanticSearchOutcome,
  SemanticSyncOutcome,
} from "./contracts.js";

const MAX_CONTENT_HASH_CHARS = 256;
const WARNING_CODES = new Set([
  "embedding-index-outdated",
  "embedding-store-unavailable",
  "embedding-entry-stale",
  "semantic-index-outdated",
  "semantic-backend-unavailable",
  "query-embedding-unavailable",
  "semantic-retrieval-error",
]);

/** Assert the load envelope and its callable opaque reader. */
export function assertSemanticLoadOutcome(value: unknown): asserts value is SemanticLoadOutcome {
  if (!isRecord(value) || !Array.isArray(value.warnings) || !validPageIds(value.stalePageIds)) {
    throw contractError("load outcome");
  }
  if (!value.warnings.every(validWarning)) throw contractError("load warnings");
  if (value.reader !== null && !validReader(value.reader)) throw contractError("reader");
}

/** Assert a chunk-search envelope and each normalized hit. */
export function assertChunkSearchOutcome(
  value: unknown,
): asserts value is SemanticSearchOutcome<SemanticChunkHit> {
  assertSearchEnvelope(value);
  if (!value.hits.every(validChunkHit)) throw contractError("chunk search hits");
}

/** Assert a page-search envelope and each normalized hit. */
export function assertPageSearchOutcome(
  value: unknown,
): asserts value is SemanticSearchOutcome<SemanticPageHit> {
  assertSearchEnvelope(value);
  if (!value.hits.every(validPageHit)) throw contractError("page search hits");
}

/** Assert sync results before they alter durable pending-index state. */
export function assertSemanticSyncOutcome(value: unknown): asserts value is SemanticSyncOutcome {
  if (!isRecord(value) || !validPageIds(value.indexed) || !validPageIds(value.eligible)) {
    throw contractError("sync outcome");
  }
  if (!Array.isArray(value.failures) || !value.failures.every(validSyncFailure)) {
    throw contractError("sync failures");
  }
}

/** Assert fields shared by both search result shapes. */
function assertSearchEnvelope(
  value: unknown,
): asserts value is { hits: unknown[]; stalePageIds: string[] } {
  if (!isRecord(value) || !Array.isArray(value.hits) || !validPageIds(value.stalePageIds)) {
    throw contractError("search outcome");
  }
}

/** Validate one backend-neutral chunk hit. */
function validChunkHit(value: unknown): value is SemanticChunkHit {
  if (!isRecord(value) || !validHitIdentity(value)) return false;
  return Number.isSafeInteger(value.chunkIndex) && (value.chunkIndex as number) >= 0
    && validOpaqueContentHash(value.contentHash)
    && typeof value.text === "string";
}

/** Treat the hash as an adapter-owned opaque identity while bounding its shape. */
function validOpaqueContentHash(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_CONTENT_HASH_CHARS && value.trim() === value;
}

/** Validate one backend-neutral page hit. */
function validPageHit(value: unknown): value is SemanticPageHit {
  return isRecord(value) && validHitIdentity(value)
    && typeof value.title === "string" && typeof value.summary === "string";
}

/** Validate identity and score fields shared by normalized hits. */
function validHitIdentity(value: Record<string, unknown>): boolean {
  const parsed = typeof value.pageId === "string" ? parseQualifiedPageId(value.pageId) : null;
  return parsed !== null && value.slug === parsed.pagePart
    && typeof value.score === "number" && Number.isFinite(value.score);
}

/** Validate warning values before consumers concatenate them. */
function validWarning(value: unknown): boolean {
  return isRecord(value) && typeof value.code === "string" && WARNING_CODES.has(value.code)
    && typeof value.message === "string";
}

/** Validate the two methods required on a loaded reader. */
function validReader(value: unknown): boolean {
  return isRecord(value) && typeof value.searchChunks === "function"
    && typeof value.searchPages === "function";
}

/** Validate page-specific and backend-wide partial failures. */
function validSyncFailure(value: unknown): boolean {
  if (!isRecord(value) || (value.operation !== "ingest" && value.operation !== "delete")) return false;
  if (typeof value.message !== "string") return false;
  return value.pageId === undefined
    || (typeof value.pageId === "string" && parseQualifiedPageId(value.pageId) !== null);
}

/** Validate a complete array of qualified page IDs. */
function validPageIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === "string" && parseQualifiedPageId(item) !== null,
  );
}

/** Stable error used for all adapter contract violations. */
function contractError(part: string): TypeError {
  return new TypeError(`Semantic backend returned an invalid ${part}.`);
}

/** Plain-record guard for untrusted JavaScript adapter values. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

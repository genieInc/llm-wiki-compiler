/**
 * @file test/semantic-config.test.ts
 * @description Configuration coverage for the optional semantic backend. R2R
 * must be selected explicitly, use a dedicated UUID collection, reject unsafe
 * remote plaintext endpoints by default, and never accept ambiguous auth.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSemanticBackendId,
  SEMANTIC_BACKEND_ENV,
} from "../src/semantic/config.js";
import { activeSemanticBackend } from "../src/semantic/registry.js";
import {
  resolveR2RConfig,
  R2R_ALLOW_HTTP_ENV,
  R2R_BASE_URL_ENV,
  R2R_COLLECTION_ID_ENV,
  R2R_CONCURRENCY_ENV,
  R2R_NAMESPACE_ENV,
  R2R_SEARCH_MODE_ENV,
} from "../src/semantic/r2r/config.js";

const COLLECTION_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => vi.unstubAllEnvs());

/** Set the minimum deterministic R2R environment for a test. */
function stubMinimumR2R(): void {
  vi.stubEnv(R2R_COLLECTION_ID_ENV, COLLECTION_ID);
  vi.stubEnv(R2R_NAMESPACE_ENV, "test-wiki");
  vi.stubEnv("R2R_API_KEY", "");
  vi.stubEnv("R2R_ACCESS_TOKEN", "");
}

describe("semantic backend configuration", () => {
  it("keeps local embeddings as the zero-configuration default", () => {
    vi.stubEnv(SEMANTIC_BACKEND_ENV, "");
    expect(resolveSemanticBackendId()).toBe("local");
  });

  it("rejects an unknown backend name instead of silently using local", () => {
    vi.stubEnv(SEMANTIC_BACKEND_ENV, "typo");
    expect(() => activeSemanticBackend()).toThrow(/local.*r2r/i);
  });

  it("uses the loopback R2R default with a normalized collection UUID", () => {
    stubMinimumR2R();
    const config = resolveR2RConfig();
    expect(config.baseUrl).toBe("http://localhost:7272");
    expect(config.collectionId).toBe(COLLECTION_ID);
    expect(config.namespace).toBe("test-wiki");
    expect(config.searchMode).toBe("basic");
  });

  it("requires a stable collection namespace to prevent cross-wiki result mixing", () => {
    vi.stubEnv(R2R_COLLECTION_ID_ENV, COLLECTION_ID);
    expect(() => resolveR2RConfig()).toThrow(/R2R_NAMESPACE/);
  });

  it("rejects plaintext non-loopback endpoints unless explicitly allowed", () => {
    stubMinimumR2R();
    vi.stubEnv(R2R_BASE_URL_ENV, "http://r2r.internal:7272");
    expect(() => resolveR2RConfig()).toThrow(/Refusing non-local HTTP/);
    vi.stubEnv(R2R_ALLOW_HTTP_ENV, "1");
    expect(resolveR2RConfig().baseUrl).toBe("http://r2r.internal:7272");
  });

  it("rejects simultaneous API-key and bearer authentication", () => {
    stubMinimumR2R();
    vi.stubEnv("R2R_API_KEY", "key");
    vi.stubEnv("R2R_ACCESS_TOKEN", "token");
    expect(() => resolveR2RConfig()).toThrow(/only one/i);
  });

  it("validates search mode and caps ingestion concurrency", () => {
    stubMinimumR2R();
    vi.stubEnv(R2R_SEARCH_MODE_ENV, "advanced");
    vi.stubEnv(R2R_CONCURRENCY_ENV, "500");
    const config = resolveR2RConfig();
    expect(config.searchMode).toBe("advanced");
    expect(config.concurrency).toBe(50);
  });
});

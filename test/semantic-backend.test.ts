/**
 * @file test/semantic-backend.test.ts
 * @description Integration seams for backend selection and the existing durable
 * pending lifecycle. R2R can bootstrap on an idle compile, while page-specific
 * partial failures remain retryable without retaining successful page IDs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSemanticReaderForSearch,
  refreshSemanticIndexLockedCore,
  SemanticBackendError,
} from "../src/semantic/index.js";
import * as semantic from "../src/semantic/index.js";
import {
  SEMANTIC_BACKEND_ENV,
} from "../src/semantic/config.js";
import {
  R2R_COLLECTION_ID_ENV,
  R2R_NAMESPACE_ENV,
  resolveR2RConfig,
} from "../src/semantic/r2r/config.js";
import { emptyR2RManifest, writeR2RManifest } from "../src/semantic/r2r/manifest.js";
import { R2RClient } from "../src/semantic/r2r/client.js";
import { retrieveSemanticChunks } from "../src/context/retrieval.js";
import { withSemanticErrorWarning } from "../src/search/retrieval.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { loadPendingEmbeddings } from "../src/utils/pending-embeddings.js";
import * as output from "../src/utils/output.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const COLLECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const temp = useTempRoot();

beforeEach(() => {
  vi.stubEnv(SEMANTIC_BACKEND_ENV, "r2r");
  vi.stubEnv(R2R_COLLECTION_ID_ENV, COLLECTION_ID);
  vi.stubEnv(R2R_NAMESPACE_ENV, "facade-tests");
  vi.stubEnv("R2R_API_KEY", "");
  vi.stubEnv("R2R_ACCESS_TOKEN", "");
  vi.spyOn(output, "status").mockImplementation(() => {});
  vi.spyOn(output, "verbose").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("R2R backend facade", () => {
  it("reports an absent R2R manifest as an outdated semantic index", async () => {
    const outcome = await loadSemanticReaderForSearch(temp.dir);
    expect(outcome.reader).toBeNull();
    expect(outcome.warnings.map((warning) => warning.code)).toEqual(["semantic-index-outdated"]);
  });

  it("loads a valid manifest behind an opaque semantic reader", async () => {
    const config = resolveR2RConfig();
    await writeR2RManifest(temp.dir, config, emptyR2RManifest(config));
    const outcome = await loadSemanticReaderForSearch(temp.dir);
    expect(outcome.reader).not.toBeNull();
    expect(outcome.warnings).toEqual([]);
  });

  it("routes the core refresh to R2R when selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await refreshSemanticIndexLockedCore(temp.dir, []);
    expect(outcome).toEqual({ indexed: [], eligible: [], failures: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies an R2R retrieval outage without exposing remote details", async () => {
    const config = resolveR2RConfig();
    await writeR2RManifest(temp.dir, config, emptyR2RManifest(config));
    vi.spyOn(R2RClient.prototype, "search").mockRejectedValue(new Error("remote secret detail"));
    const outcome = await retrieveSemanticChunks(temp.dir, "question", 3);
    expect(outcome).toEqual({
      hits: [], warning: "semantic-backend-unavailable", staleEntriesDetected: false,
    });
  });
});

describe("semantic retrieval warnings", () => {
  it.each([
    ["query-embedding-unavailable", "Could not embed the query"],
    ["semantic-retrieval-error", "failed unexpectedly"],
    ["semantic-backend-unavailable", "is unavailable"],
  ] as const)("preserves classified code %s without exposing backend details", (code, text) => {
    const error = new SemanticBackendError("custom", code, "secret provider detail", false);
    const warnings = withSemanticErrorWarning([], error);
    expect(warnings).toEqual([{ code, message: expect.stringContaining(text) }]);
    expect(warnings[0]?.message).not.toContain("secret provider detail");
  });
});

describe("pending semantic refresh", () => {
  it("runs R2R reconciliation on an idle compile so selection can bootstrap", async () => {
    const refresh = vi.spyOn(semantic, "refreshSemanticIndexLockedCore").mockResolvedValue({
      indexed: [], eligible: [], failures: [],
    });
    await refreshEmbeddingsDrainingPending(temp.dir, []);
    expect(refresh).toHaveBeenCalledWith(temp.dir, []);
  });

  it("clears successes and increments only a page-specific partial failure", async () => {
    vi.spyOn(semantic, "refreshSemanticIndexLockedCore").mockResolvedValue({
      indexed: ["concepts/alpha"],
      eligible: ["concepts/alpha", "concepts/beta"],
      failures: [{ pageId: "concepts/beta", operation: "ingest", message: "offline" }],
    });
    await refreshEmbeddingsDrainingPending(temp.dir, ["concepts/alpha", "concepts/beta"]);
    expect(await loadPendingEmbeddings(temp.dir)).toEqual([
      { pageId: "concepts/beta", attempts: 1 },
    ]);
  });
});

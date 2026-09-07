/**
 * @file test/r2r-client.test.ts
 * @description Pins llmwiki's narrow R2R v3 HTTP contract: synchronous
 * pre-chunked ingestion into default or explicit collections, namespace-scoped
 * retrieval, authentication, idempotent creates, and obsolete-document deletion.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { R2RClient, R2RHttpError, parseSearchResults } from "../src/semantic/r2r/client.js";
import type { R2RConfig } from "../src/semantic/r2r/config.js";

const COLLECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const DOCUMENT_ID = "223e4567-e89b-42d3-a456-426614174000";
const DOCUMENT_METADATA = {
  page_id: "concepts/alpha",
  llmwiki_namespace: "client-tests",
  llmwiki_content_hash: "a".repeat(64),
  llmwiki_schema_version: 1,
};
const defaultCollectionConfig: R2RConfig = {
  baseUrl: "https://r2r.example.test/prefix",
  namespace: "client-tests",
  searchMode: "advanced",
  timeoutMs: 10_000,
  concurrency: 2,
  fullSyncIntervalMs: 86_400_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  apiKey: "secret",
  projectName: "wiki",
};
const config: R2RConfig = { ...defaultCollectionConfig, collectionId: COLLECTION_ID };

afterEach(() => vi.unstubAllGlobals());

/** Install a sequential fetch mock returning the supplied responses. */
function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const mocked = vi.fn();
  for (const response of responses) mocked.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mocked);
  return mocked;
}

describe("R2RClient", () => {
  it("posts pre-chunked content synchronously to the v3 documents endpoint", async () => {
    const fetchMock = mockFetch(Response.json({ results: {} }));
    await new R2RClient(config).createDocument({ documentId: DOCUMENT_ID, chunks: ["one"], metadata: { title: "T" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const form = init.body as FormData;
    expect(url).toBe("https://r2r.example.test/prefix/v3/documents");
    expect(JSON.parse(String(form.get("chunks")))).toEqual(["one"]);
    expect(form.get("run_with_orchestration")).toBe("false");
    expect(form.get("collection_ids")).toBe(JSON.stringify([COLLECTION_ID]));
  });

  it("lets R2R select the authenticated user's default collection", async () => {
    const fetchMock = mockFetch(Response.json({ results: {} }));
    await new R2RClient(defaultCollectionConfig).createDocument({
      documentId: DOCUMENT_ID,
      chunks: ["one"],
      metadata: DOCUMENT_METADATA,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).has("collection_ids")).toBe(false);
  });

  it("treats a 409 as success only when the existing document is usable", async () => {
    const conflict = new Response("exists", { status: 409 });
    const existing = Response.json({ results: {
      id: DOCUMENT_ID,
      ingestion_status: "success",
      collection_ids: [COLLECTION_ID],
      metadata: DOCUMENT_METADATA,
    } });
    const fetchMock = mockFetch(conflict, existing);
    await expect(new R2RClient(config).createDocument({
      documentId: DOCUMENT_ID,
      chunks: ["one"],
      metadata: DOCUMENT_METADATA,
    }))
      .resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a conflict when the existing document belongs elsewhere", async () => {
    const conflict = new Response("exists", { status: 409 });
    const existing = Response.json({ results: {
      id: DOCUMENT_ID,
      ingestion_status: "success",
      collection_ids: [],
      metadata: DOCUMENT_METADATA,
    } });
    mockFetch(conflict, existing);
    await expect(new R2RClient(config).createDocument({
      documentId: DOCUMENT_ID,
      chunks: ["one"],
      metadata: DOCUMENT_METADATA,
    }))
      .rejects.toBeInstanceOf(R2RHttpError);
  });

  it("preserves a conflict when content-addressed metadata does not match", async () => {
    const conflict = new Response("exists", { status: 409 });
    const existing = Response.json({ results: {
      id: DOCUMENT_ID,
      ingestion_status: "success",
      collection_ids: [COLLECTION_ID],
      metadata: { ...DOCUMENT_METADATA, llmwiki_content_hash: "b".repeat(64) },
    } });
    mockFetch(conflict, existing);
    const create = new R2RClient(config).createDocument({
      documentId: DOCUMENT_ID,
      chunks: ["one"],
      metadata: DOCUMENT_METADATA,
    });
    await expect(create).rejects.toBeInstanceOf(R2RHttpError);
  });

  it("accepts a matching conflict from the R2R-managed default collection", async () => {
    const conflict = new Response("exists", { status: 409 });
    const existing = Response.json({ results: {
      id: DOCUMENT_ID,
      ingestion_status: "success",
      collection_ids: [COLLECTION_ID],
      metadata: DOCUMENT_METADATA,
    } });
    mockFetch(conflict, existing);
    const create = new R2RClient(defaultCollectionConfig).createDocument({
      documentId: DOCUMENT_ID,
      chunks: ["one"],
      metadata: DOCUMENT_METADATA,
    });
    await expect(create).resolves.toBeUndefined();
  });

  it("scopes retrieval to the configured collection and sends auth safely", async () => {
    const response = Response.json({ results: { chunk_search_results: [
      { document_id: DOCUMENT_ID, text: "hit", score: 0.9 },
    ] } });
    const fetchMock = mockFetch(response);
    const hits = await new R2RClient(config).search("question", 12);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    const headers = new Headers(init.headers);
    expect(payload.search_settings.filters.$and).toEqual([
      { collection_ids: { $overlap: [COLLECTION_ID] } },
      { "metadata.llmwiki_namespace": { $eq: "client-tests" } },
    ]);
    expect(payload.search_settings.limit).toBe(12);
    expect(payload.search_settings.include_metadatas).toBe(false);
    expect(payload.search_settings.graph_settings).toEqual({ enabled: false });
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("x-project-name")).toBe("wiki");
    expect(init.redirect).toBe("error");
    expect(hits[0]?.documentId).toBe(DOCUMENT_ID);
  });

  it("searches only the namespace when R2R owns collection selection", async () => {
    const response = Response.json({ results: { chunk_search_results: [] } });
    const fetchMock = mockFetch(response);
    await new R2RClient(defaultCollectionConfig).search("question", 12);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.search_settings.filters).toEqual({
      "metadata.llmwiki_namespace": { $eq: "client-tests" },
    });
  });

  it("accepts deletion of an already absent document", async () => {
    mockFetch(new Response("missing", { status: 404 }));
    await expect(new R2RClient(config).deleteDocument(DOCUMENT_ID)).resolves.toBeUndefined();
  });

  it("rejects a response declared above the safety cap before parsing it", async () => {
    const oversized = new Response("{}", { headers: { "content-length": String(33 * 1024 * 1024) } });
    mockFetch(oversized);
    await expect(new R2RClient(config).search("q", 1)).rejects.toThrow(/32 MiB safety cap/);
  });

  it("retries a transient service response under the configured bound", async () => {
    const unavailable = new Response("later", { status: 503 });
    const success = Response.json({ results: { chunk_search_results: [] } });
    const fetchMock = mockFetch(unavailable, success);
    const retrying = { ...config, maxRetries: 1 };
    await expect(new R2RClient(retrying).search("q", 1)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("parseSearchResults", () => {
  it("drops malformed chunks rather than trusting remote response shapes", () => {
    const parsed = parseSearchResults({ results: { chunkSearchResults: [
      { documentId: DOCUMENT_ID, text: "valid", score: 1 },
      { documentId: DOCUMENT_ID, text: "bad", score: "high" },
    ] } });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.text).toBe("valid");
  });

  it("rejects protocol drift instead of turning a malformed response into no hits", () => {
    expect(() => parseSearchResults({ results: { other: true } })).toThrow(/missing chunk search results/i);
    expect(() => parseSearchResults({ unexpected: true })).toThrow(/invalid search response envelope/i);
  });
});

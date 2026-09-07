/**
 * @file test/r2r-search.test.ts
 * @description Verifies that R2R only supplies ranking signals. Results must map
 * through the active text-free manifest, pass live eligibility/freshness checks,
 * and be rehydrated from confined wiki files before reaching callers.
 */

import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { SemanticSourcePage } from "../src/semantic/source-pages.js";
import { buildEmbeddingText } from "../src/utils/embeddings-pages.js";
import { hashChunkText, splitIntoChunks } from "../src/utils/retrieval.js";
import type { R2RConfig } from "../src/semantic/r2r/config.js";
import { projectPageForR2R } from "../src/semantic/r2r/document.js";
import { R2RClient } from "../src/semantic/r2r/client.js";
import { findRelevantR2RChunks, findRelevantR2RPages } from "../src/semantic/r2r/search.js";
import type { R2RSemanticIndex } from "../src/semantic/r2r/types.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

const config: R2RConfig = {
  baseUrl: "https://r2r.example.test",
  namespace: "search-tests",
  searchMode: "basic",
  timeoutMs: 10_000,
  concurrency: 2,
  fullSyncIntervalMs: 86_400_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const temp = useTempRoot();

/** Project the same page material written by the test fixture. */
function project(slug: string, title: string, summary: string, body: string) {
  const embeddingText = buildEmbeddingText({ title, summary });
  const chunkTexts = splitIntoChunks(body);
  const page: SemanticSourcePage = {
    pageId: `concepts/${slug}`,
    bareSlug: slug,
    title,
    summary,
    embeddingText,
    embeddingTextHash: hashChunkText(embeddingText),
    chunkTexts,
    chunkContentHashes: chunkTexts.map(hashChunkText),
  };
  return projectPageForR2R(page, config, "2026-01-01T00:00:00.000Z");
}

/** Build a loaded R2R handle from projected active pages. */
function indexOf(...pages: ReturnType<typeof project>[]): R2RSemanticIndex {
  return {
    config,
    manifest: {
      version: 1,
      identity: {
        baseUrl: config.baseUrl,
        namespace: config.namespace,
      },
      pages: pages.map((page) => page.manifestPage),
      orphanDocumentIds: [],
    },
    cache: {},
  };
}

describe("R2R live retrieval", () => {
  it("returns live chunk text without the context copied into R2R", async () => {
    const body = "The live body is authoritative.";
    await writePage(path.join(temp.dir, "wiki/concepts"), "alpha", { title: "Alpha", summary: "Summary" }, body);
    const projected = project("alpha", "Alpha", "Summary", body);
    vi.spyOn(R2RClient.prototype, "search").mockResolvedValue([
      { documentId: projected.documentId, text: projected.chunks[0], score: 0.92 },
    ]);

    const outcome = await findRelevantR2RChunks(temp.dir, indexOf(projected), "search", "q", 3);
    expect(outcome.stalePageIds).toEqual([]);
    expect(outcome.hits[0]?.text).toBe(body);
    expect(outcome.hits[0]?.text).not.toContain("Summary");
  });

  it("drops stale top results and continues until a fresh result fills K", async () => {
    const old = project("old", "Old", "Before", "old body");
    const fresh = project("fresh", "Fresh", "Current", "fresh body");
    const dir = path.join(temp.dir, "wiki/concepts");
    await writePage(dir, "old", { title: "Old changed", summary: "After" }, "old body");
    await writePage(dir, "fresh", { title: "Fresh", summary: "Current" }, "fresh body");
    vi.spyOn(R2RClient.prototype, "search").mockResolvedValue([
      { documentId: old.documentId, text: old.chunks[0], score: 0.99 },
      { documentId: fresh.documentId, text: fresh.chunks[0], score: 0.7 },
    ]);

    const outcome = await findRelevantR2RChunks(temp.dir, indexOf(old, fresh), "search", "q", 1);
    expect(outcome.hits.map((hit) => hit.pageId)).toEqual(["concepts/fresh"]);
    expect(outcome.stalePageIds).toEqual(["concepts/old"]);
  });

  it("ignores documents outside the active manifest", async () => {
    vi.spyOn(R2RClient.prototype, "search").mockResolvedValue([
      { documentId: "923e4567-e89b-42d3-a456-426614174000", text: "untrusted", score: 1 },
    ]);
    const outcome = await findRelevantR2RChunks(temp.dir, indexOf(), "search", "q", 3);
    expect(outcome).toEqual({ hits: [], stalePageIds: [] });
  });

  it("rehydrates an empty-body page from its page-level unit", async () => {
    await writePage(path.join(temp.dir, "wiki/concepts"), "empty", { title: "Empty", summary: "Only summary" }, "");
    const projected = project("empty", "Empty", "Only summary", "");
    vi.spyOn(R2RClient.prototype, "search").mockResolvedValue([
      { documentId: projected.documentId, text: projected.chunks[0], score: 0.8 },
    ]);
    const outcome = await findRelevantR2RPages(temp.dir, indexOf(projected), "search", "q", 3);
    expect(outcome.hits[0]).toMatchObject({ pageId: "concepts/empty", title: "Empty", summary: "Only summary" });
  });

  it("shares one remote request between chunk and page fallback passes", async () => {
    const body = "Body";
    await writePage(path.join(temp.dir, "wiki/concepts"), "alpha", { title: "Alpha" }, body);
    const projected = project("alpha", "Alpha", "", body);
    const search = vi.spyOn(R2RClient.prototype, "search").mockResolvedValue([
      { documentId: projected.documentId, text: projected.chunks[0], score: 0.8 },
    ]);
    const index = indexOf(projected);
    await findRelevantR2RChunks(temp.dir, index, "search", "q", 5);
    await findRelevantR2RPages(temp.dir, index, "search", "q", 5);
    expect(search).toHaveBeenCalledTimes(1);
  });
});

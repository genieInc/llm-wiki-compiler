/**
 * @file test/r2r-document-manifest.test.ts
 * @description Covers deterministic R2R page projection and the bounded local
 * reconciliation manifest. The manifest is intentionally text/vector-free and
 * isolated per endpoint, optional collection, and project identity.
 */

import { readFile, writeFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import type { SemanticSourcePage } from "../src/semantic/source-pages.js";
import { hashChunkText } from "../src/utils/retrieval.js";
import type { R2RConfig } from "../src/semantic/r2r/config.js";
import { projectPageForR2R } from "../src/semantic/r2r/document.js";
import {
  emptyR2RManifest,
  manifestFilename,
  parseR2RManifest,
  readR2RManifest,
  writeR2RManifest,
} from "../src/semantic/r2r/manifest.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const COLLECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const config: R2RConfig = {
  baseUrl: "https://r2r.example.test",
  namespace: "document-tests",
  searchMode: "basic",
  timeoutMs: 10_000,
  concurrency: 2,
  fullSyncIntervalMs: 86_400_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const temp = useTempRoot();

/** Construct a collected page with hashes matching the production collector. */
function collected(bodyChunks: string[] = ["Sensitive body"]): SemanticSourcePage {
  const embeddingText = "Visible title\n\nSensitive summary";
  return {
    pageId: "concepts/visible",
    bareSlug: "visible",
    title: "Visible title",
    summary: "Sensitive summary",
    embeddingText,
    embeddingTextHash: hashChunkText(embeddingText),
    chunkTexts: bodyChunks,
    chunkContentHashes: bodyChunks.map(hashChunkText),
  };
}

describe("R2R document projection", () => {
  it("uses body chunks without adding a duplicate page unit", () => {
    const projected = projectPageForR2R(collected(["one", "two"]), config, "2026-01-01T00:00:00.000Z");
    expect(projected.chunks).toHaveLength(2);
    expect(projected.manifestPage.units.map((unit) => unit.kind)).toEqual(["chunk", "chunk"]);
    expect(projected.chunks[0]).toContain("Visible title");
    expect(projected.chunks[0]).toContain("one");
  });

  it("uses one page-level unit when a page has no body", () => {
    const projected = projectPageForR2R(collected([]), config, "2026-01-01T00:00:00.000Z");
    expect(projected.chunks).toEqual(["Visible title\n\nSensitive summary"]);
    expect(projected.manifestPage.units[0]?.kind).toBe("page");
  });

  it("derives stable IDs from content and changes them when content changes", () => {
    const first = projectPageForR2R(collected(["one"]), config, "first");
    const same = projectPageForR2R(collected(["one"]), config, "later");
    const changed = projectPageForR2R(collected(["two"]), config, "later");
    expect(first.documentId).toBe(same.documentId);
    expect(changed.documentId).not.toBe(first.documentId);
  });

  it("isolates document identities and metadata by wiki namespace", () => {
    const first = projectPageForR2R(collected(), config, "first");
    const other = projectPageForR2R(collected(), { ...config, namespace: "other-wiki" }, "first");
    expect(first.documentId).not.toBe(other.documentId);
    expect(first.metadata.llmwiki_namespace).toBe("document-tests");
  });
});

describe("R2R manifest", () => {
  it("round-trips active state without persisting page text or vectors", async () => {
    const projected = projectPageForR2R(collected(), config, "2026-01-01T00:00:00.000Z");
    const manifest = { ...emptyR2RManifest(config), pages: [projected.manifestPage] };
    await writeR2RManifest(temp.dir, config, manifest);
    const loaded = await readR2RManifest(temp.dir, config);
    const raw = await readFile(path.join(temp.dir, ".llmwiki", manifestFilename(config)), "utf8");
    expect(loaded).toEqual({ kind: "ok", manifest });
    expect(raw).not.toContain("Sensitive body");
    expect(raw).not.toContain("Sensitive summary");
    expect(raw).not.toContain("vector");
  });

  it("uses a separate manifest leaf for an explicit collection", async () => {
    await writeR2RManifest(temp.dir, config, emptyR2RManifest(config));
    const other = { ...config, collectionId: COLLECTION_ID };
    expect(manifestFilename(other)).not.toBe(manifestFilename(config));
    expect(await readR2RManifest(temp.dir, other)).toEqual({ kind: "absent" });
  });

  it("uses a separate manifest leaf for another wiki namespace", () => {
    const other = { ...config, namespace: "other-wiki" };
    expect(manifestFilename(other)).not.toBe(manifestFilename(config));
  });

  it("reports corrupt state as unavailable instead of overwriting it", async () => {
    await writeR2RManifest(temp.dir, config, emptyR2RManifest(config));
    const file = path.join(temp.dir, ".llmwiki", manifestFilename(config));
    await writeFile(file, "{ corrupt");
    expect(await readR2RManifest(temp.dir, config)).toEqual({ kind: "unavailable" });
  });

  it("rejects a document that is both active and queued for deletion", () => {
    const page = projectPageForR2R(collected(), config, "2026-01-01T00:00:00.000Z").manifestPage;
    const manifest = { ...emptyR2RManifest(config), pages: [page], orphanDocumentIds: [page.documentId] };
    expect(parseR2RManifest(manifest, config)).toBeNull();
  });

  it("rejects unit topology or timestamps the writer could never produce", () => {
    const page = projectPageForR2R(collected(["one", "two"]), config, "2026-01-01T00:00:00.000Z").manifestPage;
    const skippedIndex = { ...page, units: [page.units[1], page.units[0]] };
    const invalidDate = { ...page, updatedAt: "eventually" };
    expect(parseR2RManifest({ ...emptyR2RManifest(config), pages: [skippedIndex] }, config)).toBeNull();
    expect(parseR2RManifest({ ...emptyR2RManifest(config), pages: [invalidDate] }, config)).toBeNull();
  });
});

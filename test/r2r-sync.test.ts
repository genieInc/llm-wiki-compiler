/**
 * @file test/r2r-sync.test.ts
 * @description Exercises R2R's incremental reconciliation as a state machine:
 * bootstrap all eligible pages, skip unchanged content, force explicitly changed
 * pages for crash recovery, delete removed documents, and retain partial errors.
 */

import { unlink } from "fs/promises";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { R2RConfig } from "../src/semantic/r2r/config.js";
import { R2RClient } from "../src/semantic/r2r/client.js";
import { readR2RManifest, writeR2RManifest } from "../src/semantic/r2r/manifest.js";
import { syncR2RIndex } from "../src/semantic/r2r/sync.js";
import * as output from "../src/utils/output.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

const config: R2RConfig = {
  baseUrl: "https://r2r.example.test",
  namespace: "sync-tests",
  searchMode: "basic",
  timeoutMs: 10_000,
  concurrency: 2,
  fullSyncIntervalMs: 86_400_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};
const temp = useTempRoot();

beforeEach(() => {
  vi.spyOn(output, "status").mockImplementation(() => {});
});

describe("syncR2RIndex", () => {
  it("bootstraps, skips unchanged pages, retries changed pages, and removes deleted pages", async () => {
    await writePage(path.join(temp.dir, "wiki/concepts"), "alpha", { title: "Alpha", summary: "S" }, "Body");
    const create = vi.spyOn(R2RClient.prototype, "createDocument").mockResolvedValue();
    const remove = vi.spyOn(R2RClient.prototype, "deleteDocument").mockResolvedValue();

    const initial = await syncR2RIndex(temp.dir, [], config);
    expect(initial.indexed).toEqual(["concepts/alpha"]);
    expect(create).toHaveBeenCalledTimes(1);

    await syncR2RIndex(temp.dir, [], config);
    expect(create).toHaveBeenCalledTimes(1);
    await syncR2RIndex(temp.dir, ["concepts/alpha"], config);
    expect(create).toHaveBeenCalledTimes(2);

    await unlink(path.join(temp.dir, "wiki/concepts/alpha.md"));
    await syncR2RIndex(temp.dir, ["concepts/alpha"], config);
    expect(remove).toHaveBeenCalledTimes(1);
    const read = await readR2RManifest(temp.dir, config);
    expect(read.kind === "ok" ? read.manifest.pages : null).toEqual([]);
  });

  it("commits successful pages while returning a page-specific partial failure", async () => {
    const dir = path.join(temp.dir, "wiki/concepts");
    await writePage(dir, "alpha", { title: "Alpha" }, "A body");
    await writePage(dir, "beta", { title: "Beta" }, "B body");
    vi.spyOn(R2RClient.prototype, "createDocument").mockImplementation(async (input) => {
      if (input.metadata.page_id === "concepts/beta") throw new Error("rejected beta");
    });
    vi.spyOn(R2RClient.prototype, "deleteDocument").mockResolvedValue();

    const outcome = await syncR2RIndex(temp.dir, [], config);
    const read = await readR2RManifest(temp.dir, config);
    expect(outcome.indexed).toEqual(["concepts/alpha"]);
    expect(outcome.failures).toEqual([
      { pageId: "concepts/beta", operation: "ingest", message: "rejected beta" },
    ]);
    expect(read.kind === "ok" ? read.manifest.pages.map((page) => page.pageId) : []).toEqual(["concepts/alpha"]);
  });

  it("retains failed orphan deletions for the next idle reconciliation", async () => {
    const file = path.join(temp.dir, "wiki/concepts/alpha.md");
    await writePage(path.dirname(file), "alpha", { title: "Alpha" }, "Body");
    vi.spyOn(R2RClient.prototype, "createDocument").mockResolvedValue();
    const remove = vi.spyOn(R2RClient.prototype, "deleteDocument").mockRejectedValue(new Error("offline"));
    await syncR2RIndex(temp.dir, [], config);
    await unlink(file);
    const outcome = await syncR2RIndex(temp.dir, ["concepts/alpha"], config);
    const read = await readR2RManifest(temp.dir, config);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(outcome.failures[0]?.operation).toBe("delete");
    expect(read.kind === "ok" ? read.manifest.orphanDocumentIds : []).toHaveLength(1);
  });

  it("limits normal work to changed ids and uses periodic audits for out-of-band edits", async () => {
    const dir = path.join(temp.dir, "wiki/concepts");
    await writePage(dir, "alpha", { title: "Alpha" }, "A");
    await writePage(dir, "beta", { title: "Beta" }, "B");
    const create = vi.spyOn(R2RClient.prototype, "createDocument").mockResolvedValue();
    vi.spyOn(R2RClient.prototype, "deleteDocument").mockResolvedValue();
    await syncR2RIndex(temp.dir, [], config);
    create.mockClear();

    await writePage(dir, "beta", { title: "Beta" }, "B changed out of band");
    await syncR2RIndex(temp.dir, ["concepts/alpha"], config);
    expect(create.mock.calls.map(([input]) => input.metadata.page_id)).toEqual(["concepts/alpha"]);

    const read = await readR2RManifest(temp.dir, config);
    if (read.kind !== "ok") throw new Error("expected manifest");
    await writeR2RManifest(temp.dir, config, { ...read.manifest, lastFullSyncAt: "2000-01-01T00:00:00.000Z" });
    create.mockClear();
    await syncR2RIndex(temp.dir, [], config);
    expect(create.mock.calls.map(([input]) => input.metadata.page_id)).toEqual(["concepts/beta"]);
  });
});

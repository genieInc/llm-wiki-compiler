/**
 * @file test/semantic-registry.test.ts
 * @description Contract coverage for backend discovery, runtime validation, and
 * AsyncLocalStorage isolation of custom adapters supplied to SDK Wiki instances.
 */

import { describe, expect, it } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import type { SemanticBackend } from "../src/semantic/contracts.js";
import { SemanticBackendError } from "../src/semantic/contracts.js";
import { withSemanticBackend } from "../src/semantic/context.js";
import {
  registeredSemanticBackends,
  resolveSemanticBackend,
} from "../src/semantic/registry.js";
import {
  loadSemanticReaderForContext,
  refreshSemanticIndexLockedCore,
} from "../src/semantic/service.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const temp = useTempRoot();

/** Build a minimal custom adapter that records the surface loaded by the SDK. */
function recordingBackend(id: string, loads: string[]): SemanticBackend {
  return {
    id,
    capabilities: { needsLocalEmbeddingProvider: false, reconcileWhenIdle: false },
    load: async ({ surface }) => {
      await Promise.resolve();
      loads.push(surface);
      return { reader: null, warnings: [], stalePageIds: [] };
    },
    sync: async () => ({ indexed: [], eligible: [], failures: [] }),
    classifyError: (error) => new SemanticBackendError(
      id,
      "semantic-backend-unavailable",
      "custom backend failed",
      false,
      error instanceof Error ? { cause: error } : undefined,
    ),
  };
}

describe("semantic backend registry", () => {
  it("lists both built-ins and resolves them without consumer-side switches", () => {
    expect(registeredSemanticBackends().map((backend) => backend.id)).toEqual(["local", "r2r"]);
    expect(resolveSemanticBackend("R2R")?.id).toBe("r2r");
  });

  it("validates JavaScript-supplied adapters at createWiki construction", () => {
    const invalid = { id: "Bad ID" } as unknown as SemanticBackend;
    expect(() => createWiki({ root: temp.dir, semanticBackend: invalid }))
      .toThrow(/semanticBackend\.id/);
  });

  it("keeps concurrent Wiki instance backends isolated across awaits", async () => {
    const firstLoads: string[] = [];
    const secondLoads: string[] = [];
    const first = createWiki({ root: temp.dir, semanticBackend: recordingBackend("first", firstLoads) });
    const second = createWiki({ root: temp.dir, semanticBackend: recordingBackend("second", secondLoads) });

    await Promise.all([
      first.getContextPack({ prompt: "first", topChunks: 1 }),
      second.getContextPack({ prompt: "second", topChunks: 1 }),
    ]);

    expect(firstLoads).toEqual(["context"]);
    expect(secondLoads).toEqual(["context"]);
  });

  it("accepts a structurally complete custom adapter", () => {
    const backend = recordingBackend("custom", []);
    expect(resolveSemanticBackend(backend)).toBe(backend);
  });

  it("degrades a malformed JavaScript load result at the adapter boundary", async () => {
    const backend = {
      ...recordingBackend("malformed-load", []),
      load: async () => undefined as unknown as Awaited<ReturnType<SemanticBackend["load"]>>,
      classifyError: () => ({}) as SemanticBackendError,
    };
    const outcome = await withSemanticBackend(
      backend,
      () => loadSemanticReaderForContext(temp.dir),
    );
    expect(outcome.reader).toBeNull();
    expect(outcome.warnings[0]?.code).toBe("semantic-backend-unavailable");
  });

  it("rejects malformed sync state before pending-index reconciliation", async () => {
    const backend = {
      ...recordingBackend("malformed-sync", []),
      sync: async () => ({ indexed: ["../../escape"], eligible: [], failures: [] }),
    } as unknown as SemanticBackend;
    const refresh = withSemanticBackend(
      backend,
      () => refreshSemanticIndexLockedCore(temp.dir, []),
    );
    await expect(refresh).rejects.toBeInstanceOf(SemanticBackendError);
  });
});

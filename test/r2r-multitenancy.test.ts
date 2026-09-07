/**
 * @file test/r2r-multitenancy.test.ts
 * @description Verifies that the public R2R backend factory snapshots static
 * options, validates dynamic bindings, and keeps optional collection plus
 * namespace routing isolated when one resolver serves concurrent wiki roots.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  createR2RSemanticBackend,
  type R2RSemanticBackendOptions,
  type SemanticLoadOutcome,
  type SemanticReader,
} from "../src/index.js";
import * as output from "../src/utils/output.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";

const R2R_BASE_URL = "https://r2r.example.test";
const COLLECTION_ALPHA = "123e4567-e89b-42d3-a456-426614174000";
const COLLECTION_BETA = "223e4567-e89b-42d3-a456-426614174000";

interface CapturedDocument {
  collectionId: string;
  namespace: string;
  documentId: string;
  text: string;
  apiKey: string | null;
}

interface SearchPayload {
  search_settings: {
    filters: {
      $and: [
        { collection_ids: { $overlap: string[] } },
        { "metadata.llmwiki_namespace": { $eq: string } },
      ];
    };
  };
}

interface FakeR2RTransport {
  documents: Map<string, CapturedDocument>;
  searches: Array<{ collectionId: string; namespace: string; apiKey: string | null }>;
}

const roots: string[] = [];

beforeEach(() => {
  vi.spyOn(output, "status").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Create one isolated root containing a searchable concept page. */
async function tenantRoot(label: string): Promise<string> {
  const root = await makeTempRoot(`r2r-tenant-${label.toLowerCase()}`);
  roots.push(root);
  await writePage(
    path.join(root, "wiki/concepts"),
    "shared-slug",
    { title: `Tenant ${label}`, summary: `${label} summary` },
    `${label} private body`,
  );
  return root;
}

/** Stable fake-server key matching the two filters llmwiki sends. */
function bindingKey(collectionId: string, namespace: string): string {
  return `${collectionId}\0${namespace}`;
}

/** Decode and retain one pre-chunked R2R document request. */
function captureDocument(body: BodyInit | null | undefined, headers?: HeadersInit): CapturedDocument {
  if (!(body instanceof FormData)) throw new Error("expected multipart R2R document request");
  const metadata = JSON.parse(String(body.get("metadata"))) as { llmwiki_namespace: string };
  const collectionIds = JSON.parse(String(body.get("collection_ids"))) as string[];
  const chunks = JSON.parse(String(body.get("chunks"))) as string[];
  return {
    collectionId: collectionIds[0],
    namespace: metadata.llmwiki_namespace,
    documentId: String(body.get("id")),
    text: chunks[0],
    apiKey: new Headers(headers).get("x-api-key"),
  };
}

/** Decode the tenant boundary from an R2R retrieval request. */
function captureSearch(body: BodyInit | null | undefined, headers?: HeadersInit) {
  const payload = JSON.parse(String(body)) as SearchPayload;
  const [collection, namespace] = payload.search_settings.filters.$and;
  return {
    collectionId: collection.collection_ids.$overlap[0],
    namespace: namespace["metadata.llmwiki_namespace"].$eq,
    apiKey: new Headers(headers).get("x-api-key"),
  };
}

/** Install a deterministic R2R HTTP double for ingest and retrieval. */
function installFakeR2R(): FakeR2RTransport {
  const state: FakeR2RTransport = { documents: new Map(), searches: [] };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v3/documents") && init?.method === "POST") {
      const document = captureDocument(init.body, init.headers);
      state.documents.set(bindingKey(document.collectionId, document.namespace), document);
      return Response.json({ results: {} });
    }
    if (url.endsWith("/v3/retrieval/search")) return searchResponse(state, init);
    throw new Error(`unexpected R2R request: ${url}`);
  }));
  return state;
}

/** Answer a search only from the requested collection/namespace pair. */
function searchResponse(state: FakeR2RTransport, init?: RequestInit): Response {
  const binding = captureSearch(init?.body, init?.headers);
  state.searches.push(binding);
  const document = state.documents.get(bindingKey(binding.collectionId, binding.namespace));
  const results = document
    ? [{ document_id: document.documentId, text: document.text, score: 0.9 }]
    : [];
  return Response.json({ results: { chunk_search_results: results } });
}

/** Require a reader after the test has already synchronized its manifest. */
function requireReader(outcome: SemanticLoadOutcome): SemanticReader {
  if (!outcome.reader) throw new Error(`expected semantic reader: ${JSON.stringify(outcome.warnings)}`);
  return outcome.reader;
}

/** Minimal explicit binding used by static and resolver-backed factory tests. */
function binding(collectionId: string, namespace: string, apiKey?: string): R2RSemanticBackendOptions {
  return { baseUrl: R2R_BASE_URL, collectionId, namespace, maxRetries: 0, apiKey };
}

describe("createR2RSemanticBackend multi-tenant routing", () => {
  it("snapshots static options without inheriting or retaining caller mutation", async () => {
    const root = await tenantRoot("Alpha");
    const options = {
      baseUrl: R2R_BASE_URL,
      collectionId: COLLECTION_ALPHA,
      namespace: "tenant-alpha",
      maxRetries: 0,
    };
    const backend = createR2RSemanticBackend(options);
    options.collectionId = COLLECTION_BETA;
    vi.stubEnv("R2R_API_KEY", "global-secret-must-not-leak");
    const transport = installFakeR2R();

    await backend.sync({ root, changedPageIds: [] });

    expect([...transport.documents.values()]).toMatchObject([
      { collectionId: COLLECTION_ALPHA, namespace: "tenant-alpha", apiKey: null },
    ]);
  });

  it("isolates concurrent sync and search through one root-aware resolver", async () => {
    const [alphaRoot, betaRoot] = await Promise.all([tenantRoot("Alpha"), tenantRoot("Beta")]);
    const bindings = new Map([
      [alphaRoot, binding(COLLECTION_ALPHA, "tenant-alpha", "alpha-secret")],
      [betaRoot, binding(COLLECTION_BETA, "tenant-beta", "beta-secret")],
    ]);
    const backend = createR2RSemanticBackend(async ({ root }) => {
      await Promise.resolve();
      const options = bindings.get(root);
      if (!options) throw new Error("unknown tenant root");
      return options;
    });
    const transport = installFakeR2R();

    await Promise.all([
      backend.sync({ root: alphaRoot, changedPageIds: [] }),
      backend.sync({ root: betaRoot, changedPageIds: [] }),
    ]);
    const titles = await searchTenantTitles(backend, alphaRoot, betaRoot);

    expect(titles).toEqual(["Tenant Alpha", "Tenant Beta"]);
    expect(transport.searches).toHaveLength(2);
    expect(transport.searches).toEqual(expect.arrayContaining([
      { collectionId: COLLECTION_ALPHA, namespace: "tenant-alpha", apiKey: "alpha-secret" },
      { collectionId: COLLECTION_BETA, namespace: "tenant-beta", apiKey: "beta-secret" },
    ]));
    expect([...transport.documents.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ collectionId: COLLECTION_ALPHA, apiKey: "alpha-secret" }),
      expect.objectContaining({ collectionId: COLLECTION_BETA, apiKey: "beta-secret" }),
    ]));
  });

  it("fails closed when a resolver returns an invalid tenant binding", async () => {
    const root = await tenantRoot("Invalid");
    const backend = createR2RSemanticBackend(async () => ({
      collectionId: "not-a-uuid",
      namespace: "tenant-invalid",
    }));

    await expect(backend.sync({ root, changedPageIds: [] })).rejects.toThrow(/collectionId.*UUID/);
  });

  it("rejects an unsafe static endpoint at factory construction", () => {
    expect(() => createR2RSemanticBackend({
      baseUrl: "http://r2r.example.test",
      collectionId: COLLECTION_ALPHA,
      namespace: "tenant-alpha",
    })).toThrow(/allowInsecureHttp/);
  });

  it("rejects numeric strings at the explicit JavaScript options boundary", () => {
    const options = { ...binding(COLLECTION_ALPHA, "tenant-alpha"), timeoutMs: "1000" };
    expect(() => createR2RSemanticBackend(
      options as unknown as R2RSemanticBackendOptions,
    )).toThrow(/timeoutMs must be a number/);
  });
});

/** Load and query two roots concurrently through the same backend instance. */
async function searchTenantTitles(
  backend: ReturnType<typeof createR2RSemanticBackend>,
  alphaRoot: string,
  betaRoot: string,
): Promise<Array<string | undefined>> {
  const [alpha, beta] = await Promise.all([
    backend.load({ root: alphaRoot, surface: "search" }),
    backend.load({ root: betaRoot, surface: "search" }),
  ]);
  const [alphaHits, betaHits] = await Promise.all([
    requireReader(alpha).searchPages({ question: "shared", k: 1 }),
    requireReader(beta).searchPages({ question: "shared", k: 1 }),
  ]);
  return [alphaHits.hits[0]?.title, betaHits.hits[0]?.title];
}

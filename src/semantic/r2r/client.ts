/**
 * @file src/semantic/r2r/client.ts
 * @description Minimal R2R v3 REST client for document ingestion, deletion, and
 * retrieval. It deliberately avoids the full R2R JavaScript SDK: llmwiki uses a
 * small pinned HTTP contract, validates every response it consumes, never logs
 * credentials, and refuses redirects that could forward authentication headers.
 */

import type { R2RConfig } from "./config.js";

const ERROR_BODY_MAX_CHARS = 2_000;
const RESPONSE_BODY_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RETRY_DELAY_MS = 10_000;
const IDEMPOTENCY_METADATA_KEYS = [
  "page_id",
  "llmwiki_namespace",
  "llmwiki_content_hash",
  "llmwiki_schema_version",
] as const;

/** Pre-chunked, identity-bearing document accepted by the R2R writer. */
interface R2RDocumentInput {
  documentId: string;
  chunks: string[];
  metadata: Record<string, string | number>;
}

/** Validated chunk result returned by R2R semantic/hybrid search. */
export interface R2RSearchResult {
  documentId: string;
  score: number;
  text: string;
  metadata?: Record<string, unknown>;
}

/** HTTP error retaining status for idempotent create/delete recovery. */
export class R2RHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "R2RHttpError";
  }
}

/** Small state-free client bound to one validated R2R configuration. */
export class R2RClient {
  constructor(private readonly config: R2RConfig) {}

  /** Ingest pre-chunked page content synchronously into the configured collection. */
  async createDocument(input: R2RDocumentInput): Promise<void> {
    const form = new FormData();
    form.set("chunks", JSON.stringify(input.chunks));
    form.set("id", input.documentId);
    form.set("metadata", JSON.stringify(input.metadata));
    form.set("collection_ids", JSON.stringify([this.config.collectionId]));
    form.set("run_with_orchestration", "false");
    form.set("ingestion_mode", "custom");
    try {
      await this.request("v3/documents", { method: "POST", body: form });
    } catch (error) {
      if (!(error instanceof R2RHttpError) || error.status !== 409) throw error;
      if (!(await this.existingDocumentIsUsable(input))) throw error;
    }
  }

  /** Delete a document and its chunks; an already-absent document is success. */
  async deleteDocument(documentId: string): Promise<void> {
    try {
      await this.request(`v3/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof R2RHttpError) || error.status !== 404) throw error;
    }
  }

  /** Search only the configured collection using R2R's selected preset. */
  async search(query: string, limit: number): Promise<R2RSearchResult[]> {
    const payload = {
      query,
      search_mode: this.config.searchMode,
      search_settings: {
        filters: {
          $and: [
            { collection_ids: { $overlap: [this.config.collectionId] } },
            { "metadata.llmwiki_namespace": { $eq: this.config.namespace } },
          ],
        },
        limit,
        include_metadatas: false,
        include_scores: true,
        graph_settings: { enabled: false },
      },
    };
    const raw = await this.request("v3/retrieval/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return parseSearchResults(raw);
  }

  /** Verify a content-derived ID after a prior successful/crashed ingestion. */
  private async existingDocumentIsUsable(input: R2RDocumentInput): Promise<boolean> {
    let raw: unknown;
    try {
      raw = await this.request(`v3/documents/${encodeURIComponent(input.documentId)}`, { method: "GET" });
    } catch {
      return false;
    }
    const result = resultObject(raw);
    const id = stringField(result, "id");
    const status = stringField(result, "ingestion_status", "ingestionStatus")?.toLowerCase();
    const collections = arrayField(result, "collection_ids", "collectionIds");
    const metadata = isRecord(result.metadata) ? result.metadata : {};
    return id === input.documentId && status === "success"
      && collections.includes(this.config.collectionId)
      && idempotencyMetadataMatches(input.metadata, metadata);
  }

  /** Execute one bounded, no-redirect request and decode a JSON response. */
  private async request(relativePath: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(relativePath, init);
      } catch (error) {
        if (attempt >= this.config.maxRetries || !isRetryableError(error)) throw error;
        await delay(retryDelay(attempt, this.config.retryBaseDelayMs));
      }
    }
  }

  /** Execute one bounded request attempt and decode its JSON response. */
  private async requestOnce(relativePath: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(this.url(relativePath), {
      ...init,
      headers: { ...this.headers(), ...init.headers },
      signal: AbortSignal.timeout(this.config.timeoutMs),
      redirect: "error",
    });
    const body = await readBoundedBody(response);
    if (!response.ok) throw new R2RHttpError(response.status, responseError(response.status, body));
    if (!body.trim()) return {};
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`R2R returned invalid JSON for ${relativePath}.`);
    }
  }

  /** Build an endpoint below an optional base-path prefix. */
  private url(relativePath: string): string {
    return new URL(relativePath, `${this.config.baseUrl}/`).toString();
  }

  /** Authentication and optional multi-project routing headers. */
  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      ...(this.config.apiKey && { "x-api-key": this.config.apiKey }),
      ...(this.config.accessToken && { authorization: `Bearer ${this.config.accessToken}` }),
      ...(this.config.projectName && { "x-project-name": this.config.projectName }),
    };
  }
}

/** Confirm a 409 points to the exact content-addressed llmwiki document. */
function idempotencyMetadataMatches(
  expected: Record<string, string | number>,
  actual: Record<string, unknown>,
): boolean {
  return IDEMPOTENCY_METADATA_KEYS.every((key) =>
    expected[key] === undefined || actual[key] === expected[key],
  );
}

/** Retry rate limits, timeouts, transport failures, and transient server errors. */
function isRetryableError(error: unknown): boolean {
  if (error instanceof R2RHttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

/** Exponential delay capped independently of operator-supplied settings. */
function retryDelay(attempt: number, baseDelayMs: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * (2 ** attempt));
}

/** Await retry backoff without holding a worker thread. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Read a response stream under a hard decoded-byte cap. */
async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_BODY_MAX_BYTES) {
    throw new Error("R2R response exceeds the 32 MiB safety cap.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new Error("R2R response exceeds the 32 MiB safety cap.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Parse snake_case server output and camelCase SDK-shaped fixtures alike. */
export function parseSearchResults(raw: unknown): R2RSearchResult[] {
  const results = requiredResultObject(raw, "search");
  const chunks = requiredArrayField(results, "chunk_search_results", "chunkSearchResults");
  return chunks.map(parseSearchResult).filter((item): item is R2RSearchResult => item !== null);
}

/** Validate one search result without trusting document or chunk metadata. */
function parseSearchResult(raw: unknown): R2RSearchResult | null {
  if (!isRecord(raw)) return null;
  const documentId = stringField(raw, "document_id", "documentId");
  if (!documentId || typeof raw.text !== "string" || typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
    return null;
  }
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  return { documentId, score: raw.score, text: raw.text, ...(metadata && { metadata }) };
}

/** Unwrap R2R's `{results: ...}` response envelope. */
function resultObject(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.results)) return {};
  return raw.results;
}

/** Require a valid result envelope where an empty object would hide protocol drift. */
function requiredResultObject(raw: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(raw) || !isRecord(raw.results)) {
    throw new Error(`R2R returned an invalid ${operation} response envelope.`);
  }
  return raw.results;
}

/** Read the first string field among snake/camel spellings. */
function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  return undefined;
}

/** Read the first array field among snake/camel spellings. */
function arrayField(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}

/** Require one known array field while still accepting a valid empty result set. */
function requiredArrayField(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  throw new Error("R2R search response is missing chunk search results.");
}

/** Plain-object guard used at every untrusted response boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sanitize and cap server error detail before it reaches user-facing warnings. */
function responseError(status: number, body: string): string {
  const compact = body
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_BODY_MAX_CHARS);
  return `R2R request failed with HTTP ${status}${compact ? `: ${compact}` : "."}`;
}

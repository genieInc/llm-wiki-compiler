/**
 * @file src/semantic/r2r/config.ts
 * @description Environment-only validation for the optional R2R semantic
 * backend. Selection remains backend-neutral in the parent semantic module;
 * this file owns only R2R connection, authentication, and search settings.
 */

/** R2R search presets supported by the v3 retrieval endpoint. */
export type R2RSearchMode = "basic" | "advanced" | "custom";

/** Fully validated R2R connection and indexing configuration. */
export interface R2RConfig {
  baseUrl: string;
  collectionId: string;
  namespace: string;
  searchMode: R2RSearchMode;
  timeoutMs: number;
  concurrency: number;
  fullSyncIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  apiKey?: string;
  accessToken?: string;
  projectName?: string;
}

export const R2R_BASE_URL_ENV = "R2R_BASE_URL";
export const R2R_COLLECTION_ID_ENV = "R2R_COLLECTION_ID";
export const R2R_NAMESPACE_ENV = "R2R_NAMESPACE";
export const R2R_SEARCH_MODE_ENV = "R2R_SEARCH_MODE";
const R2R_TIMEOUT_ENV = "R2R_TIMEOUT_MS";
export const R2R_CONCURRENCY_ENV = "R2R_INGEST_CONCURRENCY";
const R2R_FULL_SYNC_INTERVAL_ENV = "R2R_FULL_SYNC_INTERVAL_MS";
const R2R_MAX_RETRIES_ENV = "R2R_MAX_RETRIES";
const R2R_RETRY_BASE_DELAY_ENV = "R2R_RETRY_BASE_DELAY_MS";
export const R2R_ALLOW_HTTP_ENV = "R2R_ALLOW_INSECURE_HTTP";

const DEFAULT_R2R_BASE_URL = "http://localhost:7272";
const DEFAULT_R2R_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_R2R_CONCURRENCY = 5;
const DEFAULT_R2R_FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_R2R_MAX_RETRIES = 3;
const DEFAULT_R2R_RETRY_BASE_DELAY_MS = 250;
const MAX_R2R_CONCURRENCY = 50;
const MAX_R2R_RETRIES = 10;
const MAX_R2R_RETRY_BASE_DELAY_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEARCH_MODES = new Set<R2RSearchMode>(["basic", "advanced", "custom"]);

/** Resolve and validate every setting needed by the R2R v3 REST adapter. */
export function resolveR2RConfig(env: NodeJS.ProcessEnv = process.env): R2RConfig {
  const collectionId = requiredUuid(env[R2R_COLLECTION_ID_ENV], R2R_COLLECTION_ID_ENV);
  const namespace = requiredNamespace(env[R2R_NAMESPACE_ENV]);
  const apiKey = optionalValue(env.R2R_API_KEY);
  const accessToken = optionalValue(env.R2R_ACCESS_TOKEN);
  const projectName = optionalValue(env.R2R_PROJECT_NAME);
  if (apiKey && accessToken) throw new Error("Set only one of R2R_API_KEY and R2R_ACCESS_TOKEN.");
  return {
    baseUrl: resolveBaseUrl(env),
    collectionId,
    namespace,
    searchMode: resolveSearchMode(env[R2R_SEARCH_MODE_ENV]),
    timeoutMs: positiveInteger(env[R2R_TIMEOUT_ENV], DEFAULT_R2R_TIMEOUT_MS, R2R_TIMEOUT_ENV),
    concurrency: boundedConcurrency(env[R2R_CONCURRENCY_ENV]),
    fullSyncIntervalMs: positiveInteger(
      env[R2R_FULL_SYNC_INTERVAL_ENV],
      DEFAULT_R2R_FULL_SYNC_INTERVAL_MS,
      R2R_FULL_SYNC_INTERVAL_ENV,
    ),
    maxRetries: boundedNonNegativeInteger(
      env[R2R_MAX_RETRIES_ENV],
      DEFAULT_R2R_MAX_RETRIES,
      MAX_R2R_RETRIES,
      R2R_MAX_RETRIES_ENV,
    ),
    retryBaseDelayMs: Math.min(
      positiveInteger(env[R2R_RETRY_BASE_DELAY_ENV], DEFAULT_R2R_RETRY_BASE_DELAY_MS, R2R_RETRY_BASE_DELAY_ENV),
      MAX_R2R_RETRY_BASE_DELAY_MS,
    ),
    ...(apiKey && { apiKey }),
    ...(accessToken && { accessToken }),
    ...(projectName && { projectName }),
  };
}

/** Require a stable tenant key so shared collections cannot mix wiki results. */
function requiredNamespace(raw: string | undefined): string {
  const value = optionalValue(raw)?.toLowerCase();
  if (!value || !NAMESPACE_PATTERN.test(value)) {
    throw new Error(`${R2R_NAMESPACE_ENV} must match ${NAMESPACE_PATTERN}.`);
  }
  return value;
}

/** Parse and secure the configured R2R origin, preserving an optional path prefix. */
function resolveBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = optionalValue(env[R2R_BASE_URL_ENV]) ?? DEFAULT_R2R_BASE_URL;
  const url = parseBaseUrl(raw);
  assertBaseUrlSecurity(url, env);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Parse an absolute HTTP(S) URL without retaining a failed partial value. */
function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${R2R_BASE_URL_ENV} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${R2R_BASE_URL_ENV} must use http: or https:.`);
  }
  return url;
}

/** Reject credential-bearing URLs and unsafe remote plaintext transport. */
function assertBaseUrlSecurity(url: URL, env: NodeJS.ProcessEnv): void {
  if (url.username || url.password) throw new Error(`${R2R_BASE_URL_ENV} must not contain credentials.`);
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !enabled(env[R2R_ALLOW_HTTP_ENV])) {
    throw new Error(`Refusing non-local HTTP R2R endpoint; use HTTPS or set ${R2R_ALLOW_HTTP_ENV}=1.`);
  }
}

/** Resolve one of R2R's three documented search presets. */
function resolveSearchMode(raw: string | undefined): R2RSearchMode {
  const mode = (optionalValue(raw)?.toLowerCase() ?? "basic") as R2RSearchMode;
  if (!SEARCH_MODES.has(mode)) {
    throw new Error(`${R2R_SEARCH_MODE_ENV} must be "basic", "advanced", or "custom".`);
  }
  return mode;
}

/** Require an RFC-4122 UUID suitable for R2R document/collection fields. */
function requiredUuid(raw: string | undefined, name: string): string {
  const value = optionalValue(raw);
  if (!value || !UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID.`);
  return value.toLowerCase();
}

/** Parse a positive integer or use the supplied default when unset. */
function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = optionalValue(raw);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

/** Resolve bounded ingestion concurrency so one client cannot flood R2R. */
function boundedConcurrency(raw: string | undefined): number {
  return Math.min(
    positiveInteger(raw, DEFAULT_R2R_CONCURRENCY, R2R_CONCURRENCY_ENV),
    MAX_R2R_CONCURRENCY,
  );
}

/** Parse a non-negative integer under a hard operational cap. */
function boundedNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const value = optionalValue(raw);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return Math.min(parsed, maximum);
}

/** Trim optional configuration and collapse blank strings to absent. */
function optionalValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/** Interpret the conventional affirmative spellings used by strict mode too. */
function enabled(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(raw?.trim().toLowerCase() ?? "");
}

/** True for loopback hosts where plain HTTP cannot expose a credential remotely. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

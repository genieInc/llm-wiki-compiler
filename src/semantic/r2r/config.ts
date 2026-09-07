/**
 * @file src/semantic/r2r/config.ts
 * @description Canonical validation for environment-selected and explicitly
 * configured R2R semantic backends. Explicit options are hermetic: they never
 * inherit R2R credentials or routing from process.env, which lets concurrent
 * SDK Wiki instances bind different tenants without shared mutable state.
 */

/** R2R search presets supported by the v3 retrieval endpoint. */
export type R2RSearchMode = "basic" | "advanced" | "custom";

/** Public explicit configuration accepted by createR2RSemanticBackend. */
export interface R2RSemanticBackendOptions {
  /** R2R server URL before `/v3`; defaults to `http://localhost:7272`. */
  readonly baseUrl?: string;
  /** Optional UUID of a pre-provisioned collection; otherwise R2R uses the authenticated user's default. */
  readonly collectionId?: string;
  /** Stable lowercase wiki key, unique within the R2R endpoint and project. */
  readonly namespace: string;
  /** R2R retrieval preset; defaults to `basic`. */
  readonly searchMode?: R2RSearchMode;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Maximum concurrent document ingestions/deletions. */
  readonly ingestConcurrency?: number;
  /** Interval between full local reconciliation audits in milliseconds. */
  readonly fullSyncIntervalMs?: number;
  /** Retry count for transient transport and server failures. */
  readonly maxRetries?: number;
  /** Initial exponential retry delay in milliseconds. */
  readonly retryBaseDelayMs?: number;
  /** API key sent as `x-api-key`; mutually exclusive with accessToken. */
  readonly apiKey?: string;
  /** Bearer token; mutually exclusive with apiKey. */
  readonly accessToken?: string;
  /** Optional R2R project routed through `x-project-name`. */
  readonly projectName?: string;
  /** Explicitly permit a non-loopback plaintext HTTP endpoint. */
  readonly allowInsecureHttp?: boolean;
}

/** Trusted host context supplied when resolving one wiki's R2R binding. */
export interface R2RSemanticBackendContext {
  /** Normalized project root; a routing key, not proof of tenant authorization. */
  readonly root: string;
}

/** Resolve an already-authorized tenant/wiki binding without global mutation. */
export type R2RSemanticBackendResolver = (
  context: R2RSemanticBackendContext,
) => R2RSemanticBackendOptions | Promise<R2RSemanticBackendOptions>;

/** Fully validated internal R2R connection and indexing configuration. */
export interface R2RConfig {
  readonly baseUrl: string;
  readonly collectionId?: string;
  readonly namespace: string;
  readonly searchMode: R2RSearchMode;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly fullSyncIntervalMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly projectName?: string;
}

interface RawR2RConfig {
  baseUrl?: unknown;
  collectionId?: unknown;
  namespace?: unknown;
  searchMode?: unknown;
  timeoutMs?: unknown;
  concurrency?: unknown;
  fullSyncIntervalMs?: unknown;
  maxRetries?: unknown;
  retryBaseDelayMs?: unknown;
  apiKey?: unknown;
  accessToken?: unknown;
  projectName?: unknown;
  allowInsecureHttp?: unknown;
}

interface R2RConfigLabels {
  baseUrl: string;
  namespace: string;
  searchMode: string;
  timeoutMs: string;
  concurrency: string;
  fullSyncIntervalMs: string;
  maxRetries: string;
  retryBaseDelayMs: string;
  apiKey: string;
  accessToken: string;
  projectName: string;
  allowInsecureHttp: string;
}

const OPTION_NUMBER_KEYS = [
  "timeoutMs",
  "ingestConcurrency",
  "fullSyncIntervalMs",
  "maxRetries",
  "retryBaseDelayMs",
] as const;

export const R2R_BASE_URL_ENV = "R2R_BASE_URL";
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

const ENV_LABELS: R2RConfigLabels = {
  baseUrl: R2R_BASE_URL_ENV,
  namespace: R2R_NAMESPACE_ENV,
  searchMode: R2R_SEARCH_MODE_ENV,
  timeoutMs: R2R_TIMEOUT_ENV,
  concurrency: R2R_CONCURRENCY_ENV,
  fullSyncIntervalMs: R2R_FULL_SYNC_INTERVAL_ENV,
  maxRetries: R2R_MAX_RETRIES_ENV,
  retryBaseDelayMs: R2R_RETRY_BASE_DELAY_ENV,
  apiKey: "R2R_API_KEY",
  accessToken: "R2R_ACCESS_TOKEN",
  projectName: "R2R_PROJECT_NAME",
  allowInsecureHttp: R2R_ALLOW_HTTP_ENV,
};

const OPTION_LABELS: R2RConfigLabels = {
  baseUrl: "baseUrl",
  namespace: "namespace",
  searchMode: "searchMode",
  timeoutMs: "timeoutMs",
  concurrency: "ingestConcurrency",
  fullSyncIntervalMs: "fullSyncIntervalMs",
  maxRetries: "maxRetries",
  retryBaseDelayMs: "retryBaseDelayMs",
  apiKey: "apiKey",
  accessToken: "accessToken",
  projectName: "projectName",
  allowInsecureHttp: "allowInsecureHttp",
};

/** Resolve and validate R2R settings from the process environment. */
export function resolveR2RConfig(env: NodeJS.ProcessEnv = process.env): R2RConfig {
  return normalizeR2RConfig({
    baseUrl: env[R2R_BASE_URL_ENV],
    namespace: env[R2R_NAMESPACE_ENV],
    searchMode: env[R2R_SEARCH_MODE_ENV],
    timeoutMs: env[R2R_TIMEOUT_ENV],
    concurrency: env[R2R_CONCURRENCY_ENV],
    fullSyncIntervalMs: env[R2R_FULL_SYNC_INTERVAL_ENV],
    maxRetries: env[R2R_MAX_RETRIES_ENV],
    retryBaseDelayMs: env[R2R_RETRY_BASE_DELAY_ENV],
    apiKey: env.R2R_API_KEY,
    accessToken: env.R2R_ACCESS_TOKEN,
    projectName: env.R2R_PROJECT_NAME,
    allowInsecureHttp: enabled(env[R2R_ALLOW_HTTP_ENV]),
  }, ENV_LABELS);
}

/** Validate one explicit, environment-independent SDK configuration snapshot. */
export function resolveR2RConfigOptions(options: R2RSemanticBackendOptions): R2RConfig {
  if (!isRecord(options)) throw new TypeError("R2R semantic backend options must be an object.");
  assertExplicitNumberTypes(options);
  return normalizeR2RConfig({
    baseUrl: options.baseUrl,
    collectionId: options.collectionId,
    namespace: options.namespace,
    searchMode: options.searchMode,
    timeoutMs: options.timeoutMs,
    concurrency: options.ingestConcurrency,
    fullSyncIntervalMs: options.fullSyncIntervalMs,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    apiKey: options.apiKey,
    accessToken: options.accessToken,
    projectName: options.projectName,
    allowInsecureHttp: options.allowInsecureHttp,
  }, OPTION_LABELS);
}

/** Normalize one trusted-source snapshot without reading mutable global state. */
function normalizeR2RConfig(raw: RawR2RConfig, labels: R2RConfigLabels): R2RConfig {
  const apiKey = optionalString(raw.apiKey, labels.apiKey);
  const accessToken = optionalString(raw.accessToken, labels.accessToken);
  const projectName = optionalString(raw.projectName, labels.projectName);
  const collectionId = optionalUuid(raw.collectionId, "collectionId");
  assertUnambiguousAuth(apiKey, accessToken, labels);
  return Object.freeze({
    baseUrl: resolveBaseUrl(raw.baseUrl, raw.allowInsecureHttp, labels),
    ...(collectionId && { collectionId }),
    namespace: requiredNamespace(raw.namespace, labels.namespace),
    searchMode: resolveSearchMode(raw.searchMode, labels.searchMode),
    timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_R2R_TIMEOUT_MS, labels.timeoutMs),
    concurrency: boundedConcurrency(raw.concurrency, labels.concurrency),
    fullSyncIntervalMs: positiveInteger(
      raw.fullSyncIntervalMs,
      DEFAULT_R2R_FULL_SYNC_INTERVAL_MS,
      labels.fullSyncIntervalMs,
    ),
    maxRetries: boundedNonNegativeInteger(
      raw.maxRetries,
      DEFAULT_R2R_MAX_RETRIES,
      MAX_R2R_RETRIES,
      labels.maxRetries,
    ),
    retryBaseDelayMs: Math.min(
      positiveInteger(raw.retryBaseDelayMs, DEFAULT_R2R_RETRY_BASE_DELAY_MS, labels.retryBaseDelayMs),
      MAX_R2R_RETRY_BASE_DELAY_MS,
    ),
    ...(apiKey && { apiKey }),
    ...(accessToken && { accessToken }),
    ...(projectName && { projectName }),
  });
}

/** Reject numeric strings at the JavaScript SDK boundary while env stays string-based. */
function assertExplicitNumberTypes(options: Record<string, unknown>): void {
  for (const key of OPTION_NUMBER_KEYS) {
    const value = options[key];
    if (value !== undefined && typeof value !== "number") {
      throw new TypeError(`${key} must be a number.`);
    }
  }
}

/** Refuse two credentials because header precedence would otherwise be ambiguous. */
function assertUnambiguousAuth(
  apiKey: string | undefined,
  accessToken: string | undefined,
  labels: R2RConfigLabels,
): void {
  if (apiKey && accessToken) {
    throw new Error(`Set only one of ${labels.apiKey} and ${labels.accessToken}.`);
  }
}

/** Require a stable tenant key so shared collections cannot mix wiki results. */
function requiredNamespace(raw: unknown, name: string): string {
  const value = optionalString(raw, name)?.toLowerCase();
  if (!value || !NAMESPACE_PATTERN.test(value)) {
    throw new Error(`${name} must match ${NAMESPACE_PATTERN}.`);
  }
  return value;
}

/** Parse and secure the configured R2R origin, preserving a path prefix. */
function resolveBaseUrl(raw: unknown, allowHttp: unknown, labels: R2RConfigLabels): string {
  const value = optionalString(raw, labels.baseUrl) ?? DEFAULT_R2R_BASE_URL;
  const url = parseBaseUrl(value, labels.baseUrl);
  assertBaseUrlSecurity(url, requiredBoolean(allowHttp, labels.allowInsecureHttp), labels);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Parse an absolute HTTP(S) URL without retaining a failed partial value. */
function parseBaseUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http: or https:.`);
  }
  return url;
}

/** Reject credential-bearing URLs and unsafe remote plaintext transport. */
function assertBaseUrlSecurity(url: URL, allowHttp: boolean, labels: R2RConfigLabels): void {
  if (url.username || url.password) throw new Error(`${labels.baseUrl} must not contain credentials.`);
  if (url.protocol === "http:" && !isLoopback(url.hostname) && !allowHttp) {
    throw new Error(`Refusing non-local HTTP R2R endpoint; use HTTPS or enable ${labels.allowInsecureHttp}.`);
  }
}

/** Resolve one of R2R's three documented search presets. */
function resolveSearchMode(raw: unknown, name: string): R2RSearchMode {
  const mode = (optionalString(raw, name)?.toLowerCase() ?? "basic") as R2RSearchMode;
  if (!SEARCH_MODES.has(mode)) {
    throw new Error(`${name} must be "basic", "advanced", or "custom".`);
  }
  return mode;
}

/** Validate an optional RFC-4122 UUID suitable for R2R collection fields. */
function optionalUuid(raw: unknown, name: string): string | undefined {
  const value = optionalString(raw, name);
  if (!value) return undefined;
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a valid UUID.`);
  return value.toLowerCase();
}

/** Parse a positive integer or use the supplied default when unset. */
function positiveInteger(raw: unknown, fallback: number, name: string): number {
  const parsed = optionalNumber(raw, name);
  if (parsed === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

/** Resolve bounded ingestion concurrency so one client cannot flood R2R. */
function boundedConcurrency(raw: unknown, name: string): number {
  return Math.min(positiveInteger(raw, DEFAULT_R2R_CONCURRENCY, name), MAX_R2R_CONCURRENCY);
}

/** Parse a non-negative integer under a hard operational cap. */
function boundedNonNegativeInteger(
  raw: unknown,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const parsed = optionalNumber(raw, name);
  if (parsed === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Math.min(parsed, maximum);
}

/** Parse an environment string or explicit numeric option without coercing objects. */
function optionalNumber(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && !raw.trim()) return undefined;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new TypeError(`${name} must be a number.`);
  }
  return Number(raw);
}

/** Trim one optional string and reject wrong JavaScript runtime types. */
function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new TypeError(`${name} must be a string.`);
  const value = raw.trim();
  return value || undefined;
}

/** Require an explicit boolean after environment parsing has completed. */
function requiredBoolean(raw: unknown, name: string): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") throw new TypeError(`${name} must be a boolean.`);
  return raw;
}

/** Interpret the conventional affirmative spellings used by strict mode too. */
function enabled(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(raw?.trim().toLowerCase() ?? "");
}

/** True for loopback hosts where plain HTTP cannot expose a credential remotely. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Plain-object guard for the JavaScript-facing explicit options boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

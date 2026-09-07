/**
 * @file src/semantic/r2r/manifest.ts
 * @description Confined, bounded persistence for the R2R reconciliation
 * manifest. A separate identity-derived leaf is used for each endpoint,
 * optional collection, and R2R project, so changing backends cannot orphan one
 * configuration's state by overwriting it with another configuration's IDs.
 * The required wiki namespace also prevents result mixing in a default collection.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWrite } from "../../utils/atomic-write.js";
import { readCappedNoFollow } from "../../utils/confined-read.js";
import { parseQualifiedPageId } from "../../utils/page-id.js";
import {
  resolveConfinedPrivateDir,
  resolveExistingConfinedPrivateDir,
} from "../../utils/private-dir.js";
import type { R2RConfig } from "./config.js";
import type {
  R2RManifest,
  R2RManifestIdentity,
  R2RManifestPage,
  R2RManifestRead,
  R2RManifestUnit,
} from "./manifest-types.js";

const MANIFEST_VERSION = 1 as const;
const MANIFEST_PREFIX = "r2r-index-";
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MANIFEST_MAX_PAGES = 250_000;
const MANIFEST_MAX_ORPHANS = 250_000;
const MANIFEST_MAX_UNITS_PER_PAGE = 100_001;
const HASH_64_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build an empty manifest for a newly selected R2R configuration. */
export function emptyR2RManifest(config: R2RConfig): R2RManifest {
  return { version: MANIFEST_VERSION, identity: manifestIdentity(config), pages: [], orphanDocumentIds: [] };
}

/** Read and validate this configuration's confined manifest without creating state. */
export async function readR2RManifest(root: string, config: R2RConfig): Promise<R2RManifestRead> {
  const privateDir = await resolveExistingConfinedPrivateDir(root);
  if (privateDir === null) return { kind: "absent" };
  const read = await readCappedNoFollow(path.join(privateDir, manifestFilename(config)), MANIFEST_MAX_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unavailable" };
  try {
    const manifest = parseR2RManifest(JSON.parse(read.body), config);
    return manifest ? { kind: "ok", manifest } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Atomically persist a validated manifest under the confined private directory. */
export async function writeR2RManifest(
  root: string,
  config: R2RConfig,
  manifest: R2RManifest,
): Promise<void> {
  const validated = parseR2RManifest(manifest, config);
  if (!validated) throw new Error("Refusing to write an invalid R2R manifest.");
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MANIFEST_MAX_BYTES) throw new Error("R2R manifest exceeds its 64 MiB cap.");
  await resolveConfinedPrivateDir(root);
  const file = path.join(root, ".llmwiki", manifestFilename(config));
  await atomicWrite(file, body, { confineRoot: root, durable: true, mode: 0o600 });
}

/** Stable manifest leaf for one endpoint/optional-collection/project identity. */
export function manifestFilename(config: R2RConfig): string {
  const digest = createHash("sha256").update(JSON.stringify(manifestIdentity(config))).digest("hex").slice(0, 16);
  return `${MANIFEST_PREFIX}${digest}.json`;
}

/** Validate a parsed manifest and normalize nothing attacker-controlled. */
export function parseR2RManifest(raw: unknown, config: R2RConfig): R2RManifest | null {
  if (!isRecord(raw) || raw.version !== MANIFEST_VERSION) return null;
  if (!identityMatches(raw.identity, config)) return null;
  if (!Array.isArray(raw.pages) || raw.pages.length > MANIFEST_MAX_PAGES) return null;
  if (!Array.isArray(raw.orphanDocumentIds) || raw.orphanDocumentIds.length > MANIFEST_MAX_ORPHANS) return null;
  const pages = raw.pages.map(parsePage);
  if (pages.some((page) => page === null)) return null;
  const orphans = raw.orphanDocumentIds.filter(isUuid);
  if (orphans.length !== raw.orphanDocumentIds.length) return null;
  const typedPages = pages as R2RManifestPage[];
  if (!hasUniqueValues(typedPages.map((page) => page.pageId))) return null;
  if (!hasUniqueValues(typedPages.map((page) => page.documentId))) return null;
  const activeIds = new Set(typedPages.map((page) => page.documentId));
  if (orphans.some((documentId) => activeIds.has(documentId))) return null;
  if (raw.lastFullSyncAt !== undefined && !isIsoDate(raw.lastFullSyncAt)) return null;
  return {
    version: 1,
    identity: manifestIdentity(config),
    pages: typedPages,
    orphanDocumentIds: [...new Set(orphans)],
    ...(typeof raw.lastFullSyncAt === "string" && { lastFullSyncAt: raw.lastFullSyncAt }),
  };
}

/** Parse and validate one page record with bounded, ordered units. */
function parsePage(raw: unknown): R2RManifestPage | null {
  if (!isRecord(raw) || !hasValidPageIdentity(raw) || !hasValidPageHashes(raw)) return null;
  if (!isIsoDate(raw.updatedAt)) return null;
  const units = parseUnits(raw.units);
  if (!units) return null;
  return {
    pageId: raw.pageId as string,
    documentId: raw.documentId as string,
    contentHash: raw.contentHash as string,
    pageTextHash: raw.pageTextHash as string,
    units,
    updatedAt: raw.updatedAt,
  };
}

/** Validate the qualified local identity and R2R UUID for one page. */
function hasValidPageIdentity(raw: Record<string, unknown>): boolean {
  return typeof raw.pageId === "string" && parseQualifiedPageId(raw.pageId) !== null
    && isUuid(raw.documentId);
}

/** Validate the two full fingerprints stored on a page record. */
function hasValidPageHashes(raw: Record<string, unknown>): boolean {
  return isHash64(raw.contentHash) && isHash64(raw.pageTextHash);
}

/** Parse a bounded non-empty unit array as one all-or-nothing value. */
function parseUnits(raw: unknown): R2RManifestUnit[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MANIFEST_MAX_UNITS_PER_PAGE) return null;
  const units = raw.map(parseUnit);
  if (units.some((unit) => unit === null)) return null;
  const typed = units as R2RManifestUnit[];
  if (typed[0]?.kind === "page") return typed.length === 1 ? typed : null;
  return typed.every((unit, index) => unit.kind === "chunk" && unit.chunkIndex === index)
    ? typed
    : null;
}

/** Parse one page-level or body-chunk remote unit. */
function parseUnit(raw: unknown): R2RManifestUnit | null {
  if (!isRecord(raw) || !isHash64(raw.remoteTextHash)) return null;
  if (raw.kind === "page") return { kind: "page", remoteTextHash: raw.remoteTextHash };
  if (raw.kind !== "chunk" || !Number.isInteger(raw.chunkIndex) || (raw.chunkIndex as number) < 0) return null;
  if (!isHash64(raw.contentHash)) return null;
  return { kind: "chunk", chunkIndex: raw.chunkIndex as number, contentHash: raw.contentHash, remoteTextHash: raw.remoteTextHash };
}

/** Project connection config to the non-secret persisted identity. */
function manifestIdentity(config: R2RConfig): R2RManifestIdentity {
  return {
    baseUrl: config.baseUrl,
    ...(config.collectionId && { collectionId: config.collectionId }),
    namespace: config.namespace,
    ...(config.projectName && { projectName: config.projectName }),
  };
}

/** Verify the manifest body belongs to the identity-derived leaf being read. */
function identityMatches(raw: unknown, config: R2RConfig): boolean {
  if (!isRecord(raw)) return false;
  const expected = manifestIdentity(config);
  return raw.baseUrl === expected.baseUrl && raw.collectionId === expected.collectionId
    && raw.namespace === expected.namespace && raw.projectName === expected.projectName;
}

/** Plain-object guard used by every parser branch. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** R2R UUID validation for active and orphan document identities. */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Validate the full page reconciliation fingerprint. */
function isHash64(value: unknown): value is string {
  return typeof value === "string" && HASH_64_PATTERN.test(value);
}

/** Reject duplicate active identities before they can make mapping ambiguous. */
function hasUniqueValues(values: string[]): boolean {
  return new Set(values).size === values.length;
}

/** Accept only canonical, finite ISO timestamps for periodic full audits. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

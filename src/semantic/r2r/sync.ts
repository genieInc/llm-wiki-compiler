/**
 * @file src/semantic/r2r/sync.ts
 * @description Changed-id R2R reconciliation with periodic full local audits.
 * New or changed pages use content-derived document IDs, successful replacements
 * are committed to the local manifest, and superseded/deleted remote documents
 * are removed. Failed cleanup IDs remain durable for the next reconciliation.
 */

import pLimit from "p-limit";
import {
  collectEligibleLivePages,
  collectEligibleLivePagesById,
  type SemanticSourcePage,
} from "../source-pages.js";
import { loadProfile } from "../../profile/load.js";
import * as output from "../../utils/output.js";
import type { PageId } from "../../utils/page-id.js";
import type { R2RConfig } from "./config.js";
import { R2RClient } from "./client.js";
import { projectPageForR2R, type R2RProjectedDocument } from "./document.js";
import {
  emptyR2RManifest,
  readR2RManifest,
  writeR2RManifest,
} from "./manifest.js";
import type { R2RManifest, R2RManifestPage } from "./manifest-types.js";
import type { SemanticSyncFailure, SemanticSyncOutcome } from "../contracts.js";

/** Result of one isolated page ingestion attempt. */
interface IngestAttempt {
  page: SemanticSourcePage;
  projected: R2RProjectedDocument;
  error?: unknown;
}

/** Live pages and deletion boundary selected for this reconciliation. */
interface SyncScope {
  pages: SemanticSourcePage[];
  changed: Set<PageId>;
  isFullAudit: boolean;
  auditedAt?: string;
}

/** Reconcile the configured R2R collection with every eligible live wiki page. */
export async function syncR2RIndex(
  root: string,
  changedPageIds: PageId[],
  config: R2RConfig,
): Promise<SemanticSyncOutcome> {
  const read = await readR2RManifest(root, config);
  if (read.kind === "unavailable") throw new Error("R2R manifest is corrupt or unavailable; refusing to overwrite it.");
  const manifest = read.kind === "ok" ? read.manifest : emptyR2RManifest(config);
  const profile = await loadProfile(root);
  const scope = await selectSyncScope(root, changedPageIds, profile, manifest, read.kind, config);
  const plan = buildSyncPlan(scope.pages, manifest, scope.changed, config);
  const client = new R2RClient(config);
  const attempts = await ingestTargets(client, plan.targets, config.concurrency);
  const applied = applyIngestAttempts(manifest, scope, attempts);
  if (manifestChanged(read.kind, scope, applied)) {
    await writeR2RManifest(root, config, applied.manifest);
  }
  const cleanup = await cleanupOrphans(client, applied.manifest.orphanDocumentIds, config.concurrency);
  if (cleanup.remaining.length !== applied.manifest.orphanDocumentIds.length) {
    await writeR2RManifest(root, config, { ...applied.manifest, orphanDocumentIds: cleanup.remaining });
  }
  reportSync(applied.indexed.length, scope.pages.length, applied.removed, scope.isFullAudit);
  return {
    indexed: applied.indexed,
    eligible: scope.pages.map((page) => page.pageId),
    failures: [...applied.failures, ...cleanup.failures],
  };
}

/** Use direct changed-id reads normally and a bounded periodic full local audit. */
async function selectSyncScope(
  root: string,
  changedPageIds: PageId[],
  profile: Awaited<ReturnType<typeof loadProfile>>,
  manifest: R2RManifest,
  readKind: "absent" | "ok",
  config: R2RConfig,
): Promise<SyncScope> {
  const isFullAudit = readKind === "absent" || fullAuditIsDue(manifest, config.fullSyncIntervalMs);
  const pages = isFullAudit
    ? await collectEligibleLivePages(root, profile)
    : await collectEligibleLivePagesById(root, changedPageIds, profile);
  return {
    pages,
    changed: new Set(changedPageIds),
    isFullAudit,
    ...(isFullAudit && { auditedAt: new Date().toISOString() }),
  };
}

/** Whether enough time elapsed to detect out-of-band local page mutations. */
function fullAuditIsDue(manifest: R2RManifest, intervalMs: number): boolean {
  if (!manifest.lastFullSyncAt) return true;
  const elapsed = Date.now() - Date.parse(manifest.lastFullSyncAt);
  return elapsed < 0 || elapsed >= intervalMs;
}

/** Planned remote document writes. */
interface SyncPlan {
  targets: Array<{ page: SemanticSourcePage; projected: R2RProjectedDocument }>;
}

/** Compare live fingerprints with the manifest and build the minimal write set. */
function buildSyncPlan(
  pages: SemanticSourcePage[],
  manifest: R2RManifest,
  changed: Set<PageId>,
  config: R2RConfig,
): SyncPlan {
  const existing = new Map(manifest.pages.map((page) => [page.pageId, page]));
  const targets: SyncPlan["targets"] = [];
  for (const page of pages) {
    const projected = projectPageForR2R(page, config);
    const prior = existing.get(page.pageId);
    if (!prior || prior.contentHash !== projected.manifestPage.contentHash || changed.has(page.pageId)) {
      targets.push({ page, projected });
    }
  }
  return { targets };
}

/** Run document ingestions with bounded concurrency and retain partial results. */
async function ingestTargets(
  client: R2RClient,
  targets: SyncPlan["targets"],
  concurrency: number,
): Promise<IngestAttempt[]> {
  const limit = pLimit(concurrency);
  return Promise.all(targets.map(({ page, projected }) => limit(async () => {
    try {
      await client.createDocument(projected);
      return { page, projected };
    } catch (error) {
      return { page, projected, error };
    }
  })));
}

/** Commit successful ingestions, preserve failed prior records, and queue old IDs. */
function applyIngestAttempts(
  prior: R2RManifest,
  scope: SyncScope,
  attempts: IngestAttempt[],
): { manifest: R2RManifest; indexed: PageId[]; failures: SemanticSyncFailure[]; removed: number } {
  const liveIds = new Set(scope.pages.map((page) => page.pageId));
  const active = new Map(prior.pages.map((page) => [page.pageId, page]));
  const orphans = new Set(prior.orphanDocumentIds);
  let removed = 0;
  for (const page of prior.pages) {
    if (!shouldRemovePage(page.pageId, liveIds, scope)) continue;
    active.delete(page.pageId);
    orphans.add(page.documentId);
    removed += 1;
  }
  const indexed: PageId[] = [];
  const failures: SemanticSyncFailure[] = [];
  for (const attempt of attempts) {
    if (attempt.error) {
      failures.push({ pageId: attempt.page.pageId, operation: "ingest", message: errorMessage(attempt.error) });
      continue;
    }
    replaceActivePage(active, orphans, attempt.projected.manifestPage);
    indexed.push(attempt.page.pageId);
  }
  const manifest = {
    ...prior,
    pages: [...active.values()],
    orphanDocumentIds: [...orphans],
    ...(scope.auditedAt && { lastFullSyncAt: scope.auditedAt }),
  };
  return { manifest, indexed, failures, removed };
}

/** Full audits own all pages; incremental passes own only explicitly changed ids. */
function shouldRemovePage(pageId: PageId, liveIds: Set<PageId>, scope: SyncScope): boolean {
  if (liveIds.has(pageId)) return false;
  return scope.isFullAudit || scope.changed.has(pageId);
}

/** Persist bootstrap, audit timestamps, successful replacements, and deletions. */
function manifestChanged(
  readKind: "absent" | "ok",
  scope: SyncScope,
  applied: { indexed: PageId[]; removed: number },
): boolean {
  return readKind === "absent" || scope.isFullAudit
    || applied.indexed.length > 0 || applied.removed > 0;
}

/** Replace one active document and mark a distinct predecessor for deletion. */
function replaceActivePage(
  active: Map<PageId, R2RManifestPage>,
  orphans: Set<string>,
  replacement: R2RManifestPage,
): void {
  const old = active.get(replacement.pageId);
  orphans.delete(replacement.documentId);
  active.set(replacement.pageId, replacement);
  if (old && old.documentId !== replacement.documentId) orphans.add(old.documentId);
}

/** Delete queued remote documents, retaining failures for a later idle retry. */
async function cleanupOrphans(
  client: R2RClient,
  documentIds: string[],
  concurrency: number,
): Promise<{ remaining: string[]; failures: SemanticSyncFailure[] }> {
  const limit = pLimit(concurrency);
  const attempts = await Promise.all(documentIds.map((documentId) => limit(async () => {
    try {
      await client.deleteDocument(documentId);
      return { documentId };
    } catch (error) {
      return { documentId, error };
    }
  })));
  const failed = attempts.filter((attempt) => attempt.error !== undefined);
  return {
    remaining: failed.map((attempt) => attempt.documentId),
    failures: failed.map((attempt) => ({ operation: "delete", message: errorMessage(attempt.error) })),
  };
}

/** Emit a concise backend-specific refresh summary through the shared output layer. */
function reportSync(indexed: number, eligible: number, removed: number, fullAudit: boolean): void {
  const scope = fullAudit ? "full audit" : "incremental";
  output.status(
    "*",
    output.dim(`R2R semantic index: ${indexed} indexed, ${removed} removed (${eligible} checked; ${scope}).`),
  );
}

/** Convert arbitrary errors to bounded messages without exposing stack traces. */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

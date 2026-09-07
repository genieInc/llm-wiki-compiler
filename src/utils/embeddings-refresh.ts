/**
 * @file src/utils/embeddings-refresh.ts
 * @description The SINGLE pending-marker-draining semantic refresh both the
 * compiler and `review approve` route through, so the per-id write-ahead
 * lifecycle is never re-implemented (and never partially omitted) per call site.
 *
 * ## Why one shared drain
 * The compiler's post-write refresh and the `review approve` post-write refresh
 * are the SAME operation: union the freshly-changed page-ids into any prior
 * pending entries, write the intent ahead, run the lock-free semantic core,
 * then settle the marker per-id (clear indexed, retain eligible-unindexed,
 * quarantine ineligible-over-cap). A separate review-approve refresh that only
 * called the core for the approved id NEVER drained the accumulated marker — so a
 * project run purely as `compile --review` + `review approve` leaked pending ids
 * that were never retried, leaving semantic retrieval stale indefinitely. Folding both
 * onto this function closes that gap by construction.
 *
 * ## Lock precondition (caller MUST hold the project lock)
 * This calls {@link refreshSemanticIndexLockedCore}, the LOCK-FREE facade. Both
 * call sites already hold `.llmwiki/lock` across the
 * call (compile for its whole pipeline; `review approve` via `runReviewUnderLock`),
 * so re-locking here would deadlock. Any new caller MUST likewise hold the lock.
 *
 * ## Non-fatal
 * Semantic indexing is a non-critical enhancement: a local provider or R2R
 * failure settles the marker for a retry and warns rather than throwing, so it
 * cannot break a compile or approval unless strict mode is enabled.
 */

import {
  assertSemanticSyncSucceeded,
  refreshSemanticIndexLockedCore,
  shouldReconcileSemanticIndexWhenIdle,
  type SemanticSyncOutcome,
} from "../semantic/index.js";
import { handleSafeEmbeddingFailure } from "./embeddings-batch.js";
import { verbose } from "./output.js";
import type { PageId } from "./page-id.js";
import {
  loadPendingEmbeddings,
  writePendingEmbeddings,
  mergeFreshAttempts,
  settleAfterSuccess,
  settleAfterFailure,
  warnQuarantined,
  type PendingEmbedding,
} from "./pending-embeddings.js";

/**
 * Refresh the selected semantic backend while DRAINING the durable pending
 * marker, then settle that marker per-id. The full write-ahead lifecycle:
 *
 *  1. Load the prior pending entries and UNION `changedPageIds` into them
 *     (preserving each existing entry's accumulated failed-attempt count).
 *  2. Record the merged set to the durable, root-confined write-ahead marker
 *     BEFORE the attempt, so a swallowed failure or crash leaves a retry list.
 *  3. Run {@link refreshSemanticIndexLockedCore} (see the
 *     file-level lock precondition).
 *  4a. On SUCCESS: {@link settleAfterSuccess} clears only the ids the core
 *      actually embedded; an eligible-but-unembedded id is retained, and an
 *      ineligible id over the attempt cap is quarantined. Survivors are written
 *      back (empty → marker deleted) and quarantined ids are warned.
 *  4b. On FAILURE: {@link settleAfterFailure} increments attempts for the whole
 *      batch, quarantining any over the cap; survivors written back, quarantined
 *      warned, and the failure is surfaced non-fatally.
 *
 * Returns early when local indexing has nothing to refresh. R2R still performs
 * an idle reconciliation so a new manifest and failed deletions can recover.
 *
 * @param root - Absolute project root the marker is confined under.
 * @param changedPageIds - Qualified page-ids changed this run (may be empty —
 *   the prior pending entries are still drained).
 * @precondition The caller MUST hold the project lock across this call.
 */
export async function refreshEmbeddingsDrainingPending(
  root: string,
  changedPageIds: PageId[],
): Promise<void> {
  const merged = mergeFreshAttempts(await loadPendingEmbeddings(root), changedPageIds);
  const toRefresh = merged.map((entry) => entry.pageId);
  verbose(`semantic index: refreshing ${toRefresh.length} page-id(s)`);
  if (toRefresh.length === 0 && !shouldReconcileSemanticIndexWhenIdle()) return;
  // Write-ahead intent: record BEFORE the attempt so a swallowed failure or crash
  // leaves a durable retry list even though source-state already marks sources current.
  if (merged.length > 0) await writePendingEmbeddings(root, merged);
  let outcome: SemanticSyncOutcome;
  try {
    outcome = await refreshSemanticIndexLockedCore(root, toRefresh);
  } catch (err) {
    await settleFailedAttempt(root, merged, toRefresh);
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped semantic index update: ${message}`);
    return;
  }
  await settleSyncOutcome(root, merged, outcome);
  reportPartialFailure(outcome);
}

/** Settle a completely failed backend attempt against the durable retry marker. */
async function settleFailedAttempt(
  root: string,
  merged: PendingEmbedding[],
  attempted: PageId[],
): Promise<void> {
  const settled = settleAfterFailure(merged, attempted);
  await writePendingEmbeddings(root, settled.survivors);
  warnQuarantined(settled.quarantined);
}

/** Clear successes and age page-specific partial failures independently. */
async function settleSyncOutcome(
  root: string,
  merged: PendingEmbedding[],
  outcome: SemanticSyncOutcome,
): Promise<void> {
  const successful = settleAfterSuccess(merged, outcome.indexed, outcome.eligible);
  const failedIds = outcome.failures.flatMap((failure) => failure.pageId ? [failure.pageId] : []);
  const pendingFailures = mergeFreshAttempts(successful.survivors, failedIds);
  const failed = settleAfterFailure(pendingFailures, failedIds);
  await writePendingEmbeddings(root, failed.survivors);
  warnQuarantined([...successful.quarantined, ...failed.quarantined]);
}

/** Surface partial R2R failures non-fatally, respecting existing strict mode. */
function reportPartialFailure(outcome: SemanticSyncOutcome): void {
  if (outcome.failures.length === 0) return;
  try {
    assertSemanticSyncSucceeded(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handleSafeEmbeddingFailure(error, message);
  }
}

import type { Env } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { deleteMailboxCascade, findExpiredMailboxes } from "../db/mailboxes.js";
import { cleanupExpiredRateLimitWindows } from "../lib/rate-limit.js";

export interface CleanupResult {
  mailboxesDeleted: number;
  /** Mailboxes whose cascade failed this run; retried on the next run. */
  mailboxesFailed: number;
  rateLimitWindowsDeleted: number;
}

/**
 * Runs one bounded batch of expired-mailbox cleanup. Safe to invoke
 * repeatedly (idempotent): a mailbox that was already deleted simply won't
 * appear in the next `findExpiredMailboxes` batch, and deleting a storage
 * object key that no longer exists is a no-op rather than an error.
 *
 * Cloudflare Cron Triggers invoke this hourly (see wrangler.toml); a single
 * invocation only processes `CLEANUP_BATCH_SIZE` mailboxes so an unusually
 * large backlog cannot blow the Worker's CPU/time budget in one run — the
 * next scheduled run picks up where this one left off.
 *
 * A per-mailbox failure is isolated rather than allowed to abort the batch.
 * This matters a lot in practice: `findExpiredMailboxes` always returns the
 * OLDEST expired rows first, so a mailbox whose cascade keeps throwing (a
 * storage outage, a bad object key) would otherwise be re-selected first on
 * every single subsequent run, throwing again each time and permanently
 * starving every other expired mailbox behind it. On failure we log the
 * mailbox and move on — crucially we also do NOT delete its D1 rows, since
 * those rows are the only record of which storage keys still need removing;
 * dropping them would orphan the objects with no way left to find them.
 */
export async function runExpiredMailboxCleanup(env: Env): Promise<CleanupResult> {
  const config = loadConfig(env);
  const expired = await findExpiredMailboxes(env, config.cleanupBatchSize);

  let mailboxesDeleted = 0;
  let mailboxesFailed = 0;

  for (const mailbox of expired) {
    try {
      await deleteMailboxCascade(env, mailbox.id);
      mailboxesDeleted++;
    } catch (err) {
      mailboxesFailed++;
      console.error(
        JSON.stringify({
          level: "error",
          job: "cleanup",
          event: "mailbox-cascade-failed",
          mailboxId: mailbox.id,
          address: mailbox.address,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  // Opportunistic housekeeping for the rate-limit table; keep windows for a
  // day so short bursts of abuse remain visible for debugging, then sweep.
  const rateLimitWindowsDeleted = await cleanupExpiredRateLimitWindows(env, 24 * 60 * 60 * 1000);

  return { mailboxesDeleted, mailboxesFailed, rateLimitWindowsDeleted };
}
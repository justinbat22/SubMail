import type { Env } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { deleteMailboxCascade, findExpiredMailboxes } from "../db/mailboxes.js";
import { cleanupExpiredRateLimitWindows } from "../lib/rate-limit.js";

export interface CleanupResult {
  mailboxesDeleted: number;
  rateLimitWindowsDeleted: number;
}

/**
 * Runs one bounded batch of expired-mailbox cleanup. Safe to invoke
 * repeatedly (idempotent): a mailbox that was already deleted simply won't
 * appear in the next `findExpiredMailboxes` batch, and deleting an R2 key
 * that no longer exists is a no-op rather than an error.
 *
 * Cloudflare Cron Triggers invoke this hourly (see wrangler.toml); a single
 * invocation only processes `CLEANUP_BATCH_SIZE` mailboxes so an unusually
 * large backlog cannot blow the Worker's CPU/time budget in one run — the
 * next scheduled run picks up where this one left off.
 */
export async function runExpiredMailboxCleanup(env: Env): Promise<CleanupResult> {
  const config = loadConfig(env);
  const expired = await findExpiredMailboxes(env, config.cleanupBatchSize);

  for (const mailbox of expired) {
    await deleteMailboxCascade(env, mailbox.id);
  }

  // Opportunistic housekeeping for the rate-limit table; keep windows for a
  // day so short bursts of abuse remain visible for debugging, then sweep.
  const rateLimitWindowsDeleted = await cleanupExpiredRateLimitWindows(env, 24 * 60 * 60 * 1000);

  return { mailboxesDeleted: expired.length, rateLimitWindowsDeleted };
}

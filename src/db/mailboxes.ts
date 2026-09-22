import type { Env, MailboxRow } from "../types/index.js";
import { generateMailboxId } from "../lib/token.js";
import { deleteStoredObjects } from "../lib/b2.js";
import type { UniquenessChecker } from "../lib/username-generator.js";

export class MailboxAddressTakenError extends Error {
  constructor(address: string) {
    super(`Mailbox address already exists: ${address}`);
    this.name = "MailboxAddressTakenError";
  }
}

export interface CreateMailboxInput {
  localPart: string;
  domain: string;
  address: string;
  tokenHash: string;
  ttlHours: number;
}

/**
 * Insert a new mailbox row.
 *
 * IMPORTANT: uniqueness is enforced by the `UNIQUE(address)` constraint in
 * the database, not by a prior SELECT. A SELECT-then-INSERT approach is
 * vulnerable to a race between two concurrent requests both observing the
 * name as available. Here we simply attempt the INSERT and translate a
 * constraint violation into a typed error the caller can retry on.
 */
export async function createMailbox(
  env: Env,
  input: CreateMailboxInput
): Promise<MailboxRow> {
  const id = generateMailboxId();
  const now = Date.now();
  const expiresAt = now + input.ttlHours * 60 * 60 * 1000;

  try {
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, local_part, domain, address, token_hash, created_at, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, input.localPart, input.domain, input.address, input.tokenHash, now, now, expiresAt)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new MailboxAddressTakenError(input.address);
    }
    throw err;
  }

  return {
    id,
    local_part: input.localPart,
    domain: input.domain,
    address: input.address,
    token_hash: input.tokenHash,
    created_at: now,
    last_activity_at: now,
    expires_at: expiresAt,
  };
}

/** Detects a D1/SQLite UNIQUE constraint violation across driver error shapes. */
function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message);
}

export async function getMailboxById(env: Env, id: string): Promise<MailboxRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM mailboxes WHERE id = ?`).bind(id).first<MailboxRow>();
  return row ?? null;
}

export async function getMailboxByAddress(env: Env, address: string): Promise<MailboxRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM mailboxes WHERE address = ?`)
    .bind(address)
    .first<MailboxRow>();
  return row ?? null;
}

export async function isAddressTaken(env: Env, address: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 FROM mailboxes WHERE address = ? LIMIT 1`)
    .bind(address)
    .first();
  return row !== null;
}

export async function touchMailboxActivity(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE mailboxes SET last_activity_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run();
}

/**
 * Delete a mailbox and everything under it: messages, attachment metadata,
 * and the corresponding objects in Backblaze B2. Messages/attachments
 * cascade at the D1 level via ON DELETE CASCADE, but B2 objects must be
 * removed explicitly since B2 has no knowledge of D1 foreign keys.
 */
export async function deleteMailboxCascade(env: Env, mailboxId: string): Promise<void> {
  const attachmentRows = await env.DB.prepare(
    `SELECT a.r2_key AS r2_key
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE m.mailbox_id = ?`
  )
    .bind(mailboxId)
    .all<{ r2_key: string }>();

  const keys = (attachmentRows.results ?? []).map((r) => r.r2_key);
  await deleteStoredObjects(env, keys);

  // ON DELETE CASCADE removes messages and attachments rows automatically.
  await env.DB.prepare(`DELETE FROM mailboxes WHERE id = ?`).bind(mailboxId).run();
}

/** Adapter so the username generator's collision-retry loop can query D1 directly. */
export function makeD1UniquenessChecker(env: Env, domain: string): UniquenessChecker {
  return {
    async isTaken(localPart: string): Promise<boolean> {
      const address = `${localPart}@${domain}`;
      return isAddressTaken(env, address);
    },
  };
}

/** Find a bounded batch of expired mailboxes for cron-driven cleanup. */
export async function findExpiredMailboxes(
  env: Env,
  limit: number
): Promise<Pick<MailboxRow, "id" | "address">[]> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `SELECT id, address FROM mailboxes WHERE expires_at <= ? LIMIT ?`
  )
    .bind(now, limit)
    .all<Pick<MailboxRow, "id" | "address">>();
  return result.results ?? [];
}

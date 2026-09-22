import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { createMailbox } from "../src/db/mailboxes.js";
import { createMessage, createAttachment, buildAttachmentR2Key } from "../src/db/messages.js";
import { hashToken, generateMailboxToken } from "../src/lib/token.js";
import { runExpiredMailboxCleanup } from "../src/cleanup/expired-mailboxes.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

/** Create a mailbox and force its expiry (or non-expiry) directly via SQL, for cleanup testing. */
async function createMailboxWithExpiry(localPart: string, expiresAt: number) {
  const tokenHash = await hashToken(generateMailboxToken());
  const mailbox = await createMailbox(env, {
    localPart,
    domain: "example.com",
    address: `${localPart}@example.com`,
    tokenHash,
    ttlHours: 48,
  });
  await env.DB.prepare("UPDATE mailboxes SET expires_at = ? WHERE id = ?").bind(expiresAt, mailbox.id).run();
  return mailbox;
}

describe("runExpiredMailboxCleanup", () => {
  it("deletes an expired mailbox and leaves a non-expired one untouched", async () => {
    const expired = await createMailboxWithExpiry("expired-one", Date.now() - 1000);
    const active = await createMailboxWithExpiry("still-active", Date.now() + 1000 * 60 * 60);

    const result = await runExpiredMailboxCleanup(env);
    expect(result.mailboxesDeleted).toBe(1);

    const expiredRow = await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(expired.id).first();
    const activeRow = await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(active.id).first();
    expect(expiredRow).toBeNull();
    expect(activeRow).not.toBeNull();
  });

  it("cascades deletion to messages, attachment metadata, and R2 objects", async () => {
    const mailbox = await createMailboxWithExpiry("with-mail", Date.now() - 1000);
    const message = await createMessage(env, {
      mailboxId: mailbox.id,
      messageId: null,
      senderName: "Sender",
      senderAddress: "sender@outside.example",
      recipientAddress: mailbox.address,
      subject: "Hello",
      textBody: "hi",
      htmlBody: null,
      sizeBytes: 100,
      hasAttachments: true,
    });

    const r2Key = buildAttachmentR2Key(mailbox.id, message.id);
    await env.ATTACHMENTS.put(r2Key, new TextEncoder().encode("file contents"));
    await createAttachment(env, {
      messageId: message.id,
      filename: "file.txt",
      contentType: "text/plain",
      sizeBytes: 13,
      r2Key,
    });

    await runExpiredMailboxCleanup(env);

    const messageRow = await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?").bind(message.id).first();
    const attachmentRow = await env.DB.prepare("SELECT 1 FROM attachments WHERE message_id = ?")
      .bind(message.id)
      .first();
    const r2Object = await env.ATTACHMENTS.get(r2Key);

    expect(messageRow).toBeNull();
    expect(attachmentRow).toBeNull();
    expect(r2Object).toBeNull();
  });

  it("processes at most CLEANUP_BATCH_SIZE mailboxes per invocation", async () => {
    const batchSize = Number(env.CLEANUP_BATCH_SIZE);
    // Create more expired mailboxes than one batch can hold.
    const total = batchSize + 5;
    for (let i = 0; i < total; i++) {
      await createMailboxWithExpiry(`batch-${i}`, Date.now() - 1000);
    }

    const firstRun = await runExpiredMailboxCleanup(env);
    expect(firstRun.mailboxesDeleted).toBe(batchSize);

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(remaining?.count).toBe(total - batchSize);

    // A second invocation picks up the rest — demonstrates the batching
    // doesn't lose mailboxes, just spreads the work across runs.
    const secondRun = await runExpiredMailboxCleanup(env);
    expect(secondRun.mailboxesDeleted).toBe(5);

    const finalCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(finalCount?.count).toBe(0);
  }, 15000);

  it("is idempotent: running again with nothing expired deletes nothing and does not error", async () => {
    await createMailboxWithExpiry("expired-again", Date.now() - 1000);

    const first = await runExpiredMailboxCleanup(env);
    expect(first.mailboxesDeleted).toBe(1);

    const second = await runExpiredMailboxCleanup(env);
    expect(second.mailboxesDeleted).toBe(0);

    const third = await runExpiredMailboxCleanup(env);
    expect(third.mailboxesDeleted).toBe(0);
  });

  it("handles an empty mailboxes table without error", async () => {
    const result = await runExpiredMailboxCleanup(env);
    expect(result.mailboxesDeleted).toBe(0);
  });

  it("also sweeps stale rate-limit windows older than 24 hours", async () => {
    const oldWindow = Date.now() - 25 * 60 * 60 * 1000;
    const recentWindow = Date.now();
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
      .bind("test:old", oldWindow)
      .run();
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
      .bind("test:recent", recentWindow)
      .run();

    await runExpiredMailboxCleanup(env);

    const oldRow = await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = ?").bind("test:old").first();
    const recentRow = await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = ?").bind("test:recent").first();
    expect(oldRow).toBeNull();
    expect(recentRow).not.toBeNull();
  });
});

import type { Env } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { getMailboxByAddress, touchMailboxActivity } from "../db/mailboxes.js";
import {
  buildAttachmentR2Key,
  countMessagesForMailbox,
  createMessageWithAttachments,
  getMessageByMailboxAndMessageId,
  MailboxFullError,
  DuplicateMessageError,
  type CreateAttachmentInput,
} from "../db/messages.js";
import { parseRawEmail, EmailParseError } from "./parser.js";
import { validateAttachment } from "../lib/attachment-validation.js";
import { normalizeLocalPart } from "../lib/validation.js";
import { putStoredObject, deleteStoredObjects } from "../lib/b2.js";

/**
 * Handles one incoming message delivered by Cloudflare Email Routing.
 *
 * Design notes (see README "Email receiving" for the full write-up):
 *
 *  - `message.to` is the *envelope* recipient Cloudflare's routing already
 *    matched to invoke this Worker — it is authoritative for mailbox lookup.
 *    Parsed `To`/`Cc` headers are attacker-controlled and are never used for
 *    routing decisions, only stored as display metadata.
 *
 *  - An unknown recipient is *not* an error: we must not auto-create a
 *    mailbox, must not store anything, and must return success to the mail
 *    infrastructure (i.e. just return normally — Cloudflare treats a normal
 *    return as accepted-and-handled).
 *
 *  - Oversized messages and mailboxes at their message-count cap are
 *    rejected with `setReject`, a permanent SMTP-level bounce — the same
 *    behavior a real, capacity-limited mail server would exhibit. The count
 *    check here is a fast *pre-check* only (avoids wasted parsing/upload
 *    work for an obviously-full mailbox); the actual, race-safe enforcement
 *    is the database trigger in migrations/0003_mailbox_message_limit.sql,
 *    handled below via MailboxFullError.
 *
 *  - PERMANENT vs TRANSIENT failures are handled differently on purpose:
 *      - Permanent (malformed MIME, mailbox full, message too large, unknown
 *        recipient, duplicate/already-processed delivery): handled here,
 *        function returns normally (with setReject for the bounce cases).
 *        These are never retried, because retrying would never succeed.
 *      - Transient (a B2 upload failure, an unexpected D1 error): this
 *        function lets the error propagate. The `email()` entrypoint in
 *        src/index.ts does NOT catch-and-swallow these — an uncaught
 *        exception here causes Cloudflare to treat the delivery as failed,
 *        which is what lets the sending MTA's normal retry behavior kick
 *        in. Silently swallowing these would otherwise cause a message to
 *        vanish forever after a purely transient infrastructure hiccup.
 *
 *  - B2 objects are uploaded BEFORE any D1 row is written, and the D1
 *    message row + all its attachment rows are written together in a single
 *    atomic batch (see createMessageWithAttachments). This ordering means a
 *    message can never end up "half stored": either everything about it is
 *    durably recorded, or nothing is. If the D1 batch fails for any reason
 *    after B2 uploads already succeeded, those objects are deleted
 *    (best-effort) so they don't become permanent orphans.
 *
 *  - Idempotency: retried delivery of a message this mailbox already has
 *    (same Message-ID) is detected via a UNIQUE(mailbox_id, message_id)
 *    index and treated as a successful no-op rather than creating a
 *    duplicate — see DuplicateMessageError handling below.
 */
export async function handleIncomingEmail(
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> {
  const config = loadConfig(env);

  const recipientAddress = normalizeRecipient(message.to);
  const mailbox = await getMailboxByAddress(env, recipientAddress);

  if (!mailbox) {
    // Unknown/expired recipient: silently and safely discard. Do not create
    // a mailbox, do not store anything, do not bounce (bouncing to an
    // unknown/possibly-spoofed sender is itself a minor abuse vector and is
    // unnecessary here since our own address space is fully known to us).
    return;
  }

  if (mailbox.expires_at <= Date.now()) {
    // Expired mailbox not yet swept by the cron job. Treat identically to
    // "unknown recipient" — never resurrect an expired mailbox by accepting
    // mail into it.
    return;
  }

  if (message.rawSize > config.maxMessageSize) {
    message.setReject("Message too large.");
    return;
  }

  const existingCount = await countMessagesForMailbox(env, mailbox.id);
  if (existingCount >= config.maxMessagesPerMailbox) {
    message.setReject("Mailbox is full.");
    return;
  }

  const raw = await readAll(message.raw);

  let parsed;
  try {
    parsed = await parseRawEmail(raw);
  } catch (err) {
    if (err instanceof EmailParseError) {
      // Malformed/pathological MIME: permanent condition, safely discard
      // rather than storing garbage, retrying forever, or spending unbounded
      // CPU on it. Never retried.
      console.error(JSON.stringify({ level: "error", job: "email-parse", message: err.message }));
      return;
    }
    throw err;
  }

  // Idempotency short-circuit: if this exact (mailbox, Message-ID) has
  // already been stored — almost always a retried delivery after an earlier
  // transient failure further down this same function — treat it as an
  // already-successful no-op. Checked before doing any parsing-adjacent
  // work like storage uploads, to avoid redundant work on every retry.
  if (parsed.messageId) {
    const existing = await getMessageByMailboxAndMessageId(env, mailbox.id, parsed.messageId);
    if (existing) {
      console.log(JSON.stringify({
        level: "info",
        job: "email-handler",
        event: "duplicate-delivery-skipped",
        mailboxId: mailbox.id,
      }));
      return;
    }
  }

  const validAttachments = parsed.attachments
    .map((a) => ({
      attachment: a,
      validation: validateAttachment({
        filename: a.filename,
        sizeBytes: a.sizeBytes,
        maxAttachmentSize: config.maxAttachmentSize,
      }),
    }))
    .filter((entry) => entry.validation.valid)
    .slice(0, config.maxAttachmentsPerMessage);

  // --- B2 (object storage) first --------------------------------------
  // Upload every attachment's bytes before touching D1 at all. If any
  // upload fails partway through, clean up whatever succeeded in this
  // attempt and rethrow (transient — no D1 rows exist yet, so a retry from
  // scratch is safe and won't create duplicates or partial state).
  const uploadedKeys: string[] = [];
  const attachmentInputs: CreateAttachmentInput[] = [];

  try {
    for (const { attachment, validation } of validAttachments) {
      const objectKey = buildAttachmentR2Key(mailbox.id, parsed.messageId ?? "no-message-id");
      await putStoredObject(env, objectKey, attachment.content, attachment.contentType);
      uploadedKeys.push(objectKey);
      attachmentInputs.push({
        messageId: "", // unused placeholder — createMessageWithAttachments assigns the real message id
        filename: validation.sanitizedFilename ?? "attachment",
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        r2Key: objectKey,
      });
    }
  } catch (err) {
    await bestEffortDeleteStorageObjects(env, uploadedKeys, "b2-upload-failed");
    throw err; // transient — let Cloudflare retry
  }

  // --- Then D1, atomically ---------------------------------------------
  try {
    await createMessageWithAttachments(
      env,
      {
        mailboxId: mailbox.id,
        messageId: parsed.messageId,
        senderName: parsed.senderName,
        senderAddress: parsed.senderAddress,
        recipientAddress,
        subject: parsed.subject,
        textBody: parsed.textBody,
        htmlBody: parsed.htmlBody,
        sizeBytes: message.rawSize,
        hasAttachments: attachmentInputs.length > 0,
      },
      attachmentInputs
    );
  } catch (err) {
    if (err instanceof MailboxFullError) {
      // The fast pre-check above passed, but a concurrent delivery filled
      // the last slot before this one's D1 write landed — the trigger is
      // the authoritative backstop for exactly this race. Clean up this
      // attempt's uploads and bounce, same as the fast-path case.
      await bestEffortDeleteStorageObjects(env, uploadedKeys, "mailbox-full-after-upload");
      message.setReject("Mailbox is full.");
      return;
    }
    if (err instanceof DuplicateMessageError) {
      // Another (likely retried) delivery already stored this exact
      // message between our idempotency check above and this write. This
      // attempt's uploads are redundant duplicates of already-stored
      // content — remove them and treat this as a successful no-op.
      await bestEffortDeleteStorageObjects(env, uploadedKeys, "duplicate-after-upload");
      return;
    }
    // Genuinely unexpected — clean up this attempt's uploads and propagate
    // so Cloudflare treats this delivery as failed and retries it.
    await bestEffortDeleteStorageObjects(env, uploadedKeys, "d1-write-failed");
    throw err;
  }

  await touchMailboxActivity(env, mailbox.id);
}

/**
 * Best-effort cleanup of B2 objects uploaded during an attempt that didn't
 * end up completing. "Best-effort" is doing real work here: if the delete
 * itself fails, we log it clearly (rather than silently swallowing) so an
 * orphaned B2 object is at least visible for manual/administrative cleanup,
 * since true exactly-once cleanup across two independent storage systems
 * isn't achievable without a durable outbox log — a deliberate, documented
 * trade-off (see README "Known limitations").
 */
async function bestEffortDeleteStorageObjects(env: Env, keys: string[], reason: string): Promise<void> {
  if (keys.length === 0) return;
  try {
    await deleteStoredObjects(env, keys);
  } catch (cleanupErr) {
    console.error(JSON.stringify({
      level: "error",
      job: "email-handler",
      event: "b2-compensation-failed",
      reason,
      keyCount: keys.length,
      message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    }));
  }
}

function normalizeRecipient(envelopeTo: string): string {
  const [localPart, domain] = envelopeTo.split("@");
  if (!localPart || !domain) return envelopeTo.toLowerCase();
  return `${normalizeLocalPart(localPart)}@${domain.toLowerCase()}`;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

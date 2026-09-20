import type { Env } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { getMailboxByAddress, touchMailboxActivity } from "../db/mailboxes.js";
import {
  buildAttachmentR2Key,
  countMessagesForMailbox,
  createAttachment,
  createMessage,
} from "../db/messages.js";
import { parseRawEmail, EmailParseError } from "./parser.js";
import { validateAttachment } from "../lib/attachment-validation.js";
import { normalizeLocalPart } from "../lib/validation.js";

/**
 * Handles one incoming message delivered by Cloudflare Email Routing.
 *
 * Design notes (see README "Email receiving" for the full write-up):
 *  - `message.to` is the *envelope* recipient Cloudflare's routing already
 *    matched to invoke this Worker — it is authoritative for mailbox lookup.
 *    Parsed `To`/`Cc` headers are attacker-controlled and are never used for
 *    routing decisions, only stored as display metadata.
 *  - An unknown recipient is *not* an error: per the spec, we must not
 *    auto-create a mailbox, must not store anything, and must return
 *    success to the mail infrastructure (i.e. just return normally without
 *    calling setReject/forward — Cloudflare treats a normal return as
 *    accepted-and-handled).
 *  - Oversized messages and mailboxes at their message-count cap are
 *    rejected with `setReject`, which causes a permanent SMTP-level bounce
 *    back to the sender — the same behavior a real, capacity-limited mail
 *    server would exhibit, and cheaper than parsing first.
 *  - Attachment failures (individual attachment too large, or too many
 *    attachments) never fail the whole message: the message and any valid
 *    attachments are still stored, and offending attachments are simply
 *    dropped. This mirrors how real mail providers commonly handle
 *    oversized inline content, and avoids losing an otherwise-deliverable
 *    message over one bad part.
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
      // Malformed MIME: safely discard rather than storing garbage or
      // crashing. This is a deliberate trade-off — a real mail server would
      // often still accept a malformed message, but here there's nothing
      // safe to show the user for content we couldn't parse.
      console.error(JSON.stringify({ level: "error", job: "email-parse", message: err.message }));
      return;
    }
    throw err;
  }

  const validAttachments = parsed.attachments
    .map((a) => ({ attachment: a, validation: validateAttachment({
      filename: a.filename,
      sizeBytes: a.sizeBytes,
      maxAttachmentSize: config.maxAttachmentSize,
    }) }))
    .filter((entry) => entry.validation.valid)
    .slice(0, config.maxAttachmentsPerMessage);

  const stored = await createMessage(env, {
    mailboxId: mailbox.id,
    messageId: parsed.messageId,
    senderName: parsed.senderName,
    senderAddress: parsed.senderAddress,
    recipientAddress,
    subject: parsed.subject,
    textBody: parsed.textBody,
    htmlBody: parsed.htmlBody,
    sizeBytes: message.rawSize,
    hasAttachments: validAttachments.length > 0,
  });

  for (const { attachment, validation } of validAttachments) {
    const r2Key = buildAttachmentR2Key(mailbox.id, stored.id);
    await env.ATTACHMENTS.put(r2Key, attachment.content, {
      httpMetadata: { contentType: attachment.contentType },
    });
    await createAttachment(env, {
      messageId: stored.id,
      filename: validation.sanitizedFilename ?? "attachment",
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      r2Key,
    });
  }

  await touchMailboxActivity(env, mailbox.id);
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

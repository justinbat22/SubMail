import type { AttachmentRow, Env, MessageRow } from "../types/index.js";
import { generateId } from "../lib/token.js";

export interface CreateMessageInput {
  mailboxId: string;
  messageId: string | null;
  senderName: string | null;
  senderAddress: string | null;
  recipientAddress: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  sizeBytes: number;
  hasAttachments: boolean;
}

export async function createMessage(env: Env, input: CreateMessageInput): Promise<MessageRow> {
  const id = generateId();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO messages
       (id, mailbox_id, message_id, sender_name, sender_address, recipient_address,
        subject, text_body, html_body, created_at, size_bytes, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      input.mailboxId,
      input.messageId,
      input.senderName,
      input.senderAddress,
      input.recipientAddress,
      input.subject,
      input.textBody,
      input.htmlBody,
      now,
      input.sizeBytes,
      input.hasAttachments ? 1 : 0
    )
    .run();

  return {
    id,
    mailbox_id: input.mailboxId,
    message_id: input.messageId,
    sender_name: input.senderName,
    sender_address: input.senderAddress,
    recipient_address: input.recipientAddress,
    subject: input.subject,
    text_body: input.textBody,
    html_body: input.htmlBody,
    created_at: now,
    size_bytes: input.sizeBytes,
    has_attachments: input.hasAttachments ? 1 : 0,
  };
}

export interface CreateAttachmentInput {
  messageId: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  r2Key: string;
}

export async function createAttachment(env: Env, input: CreateAttachmentInput): Promise<AttachmentRow> {
  const id = generateId();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, input.messageId, input.filename, input.contentType, input.sizeBytes, input.r2Key, now)
    .run();

  return {
    id,
    message_id: input.messageId,
    filename: input.filename,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    r2_key: input.r2Key,
    created_at: now,
  };
}

/** Build a random, non-guessable R2 object key. Never derived from the filename or address. */
export function buildAttachmentR2Key(mailboxId: string, messageId: string): string {
  return `attachments/${mailboxId}/${messageId}/${generateId()}`;
}

export async function countMessagesForMailbox(env: Env, mailboxId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?`)
    .bind(mailboxId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface ListMessagesOptions {
  limit: number;
  offset: number;
}

export async function listMessagesForMailbox(
  env: Env,
  mailboxId: string,
  options: ListMessagesOptions
): Promise<MessageRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM messages WHERE mailbox_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(mailboxId, options.limit, options.offset)
    .all<MessageRow>();
  return result.results ?? [];
}

/** Fetch a message, scoped to a specific mailbox so one mailbox can never read another's mail. */
export async function getMessageForMailbox(
  env: Env,
  mailboxId: string,
  messageId: string
): Promise<MessageRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND mailbox_id = ?`)
    .bind(messageId, mailboxId)
    .first<MessageRow>();
  return row ?? null;
}

export async function listAttachmentsForMessage(env: Env, messageId: string): Promise<AttachmentRow[]> {
  const result = await env.DB.prepare(`SELECT * FROM attachments WHERE message_id = ?`)
    .bind(messageId)
    .all<AttachmentRow>();
  return result.results ?? [];
}

/**
 * Fetch an attachment scoped to a specific mailbox (joins through messages),
 * so an attachment ID alone is never sufficient to read another mailbox's
 * file — the caller must also be authenticated as the owning mailbox.
 */
export async function getAttachmentForMailbox(
  env: Env,
  mailboxId: string,
  attachmentId: string
): Promise<AttachmentRow | null> {
  const row = await env.DB.prepare(
    `SELECT a.* FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE a.id = ? AND m.mailbox_id = ?`
  )
    .bind(attachmentId, mailboxId)
    .first<AttachmentRow>();
  return row ?? null;
}

/** Delete a single message, its attachment rows (cascade), and their R2 objects. */
export async function deleteMessageCascade(env: Env, mailboxId: string, messageId: string): Promise<boolean> {
  const attachments = await env.DB.prepare(
    `SELECT a.r2_key AS r2_key
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE a.message_id = ? AND m.mailbox_id = ?`
  )
    .bind(messageId, mailboxId)
    .all<{ r2_key: string }>();

  const keys = (attachments.results ?? []).map((r) => r.r2_key);
  if (keys.length > 0) {
    await env.ATTACHMENTS.delete(keys);
  }

  const result = await env.DB.prepare(`DELETE FROM messages WHERE id = ? AND mailbox_id = ?`)
    .bind(messageId, mailboxId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

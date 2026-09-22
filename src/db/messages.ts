import type { AttachmentRow, Env, MessageRow } from "../types/index.js";
import { generateId } from "../lib/token.js";

export class MailboxFullError extends Error {
  constructor(mailboxId: string) {
    super(`Mailbox ${mailboxId} is at its message limit.`);
    this.name = "MailboxFullError";
  }
}

export class DuplicateMessageError extends Error {
  constructor(mailboxId: string, messageId: string) {
    super(`Message ${messageId} was already stored for mailbox ${mailboxId}.`);
    this.name = "DuplicateMessageError";
  }
}

function isMailboxFullError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /MAILBOX_FULL/.test(message);
}

function isMessageUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Specifically the (mailbox_id, message_id) idempotency index — see
  // migrations/0004_message_idempotency.sql — not just any UNIQUE failure,
  // so an unrelated constraint violation isn't misreported as a duplicate.
  return /UNIQUE constraint failed/i.test(message) && /messages\.mailbox_id/i.test(message);
}

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

export interface CreateAttachmentInput {
  messageId: string;
  filename: string;
  contentType: string | null;
  sizeBytes: number;
  r2Key: string;
}

export async function createMessage(env: Env, input: CreateMessageInput): Promise<MessageRow> {
  const id = generateId();
  const now = Date.now();

  try {
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
  } catch (err) {
    if (isMailboxFullError(err)) throw new MailboxFullError(input.mailboxId);
    if (isMessageUniqueConstraintError(err)) {
      throw new DuplicateMessageError(input.mailboxId, input.messageId ?? "(none)");
    }
    throw err;
  }

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

export interface CreateMessageWithAttachmentsResult {
  message: MessageRow;
  attachments: AttachmentRow[];
}

/**
 * Atomically inserts a message and all of its attachment metadata rows as a
 * single D1 batch (verified empirically to be all-or-nothing: if any
 * statement in the batch fails, none of them commit — see the test suite's
 * concurrency tests for a live demonstration). This is deliberately used
 * instead of "insert message, then loop inserting attachments" so a message
 * can never end up half-stored (message row present, some attachments
 * missing) purely because of a D1-side failure partway through.
 *
 * Two expected failure modes are translated into typed errors the caller is
 * expected to handle as normal outcomes, not crashes:
 *   - MailboxFullError: the mailbox_message_limit trigger aborted the
 *     insert because the mailbox is already at its configured cap. This is
 *     the *authoritative* enforcement of MAX_MESSAGES_PER_MAILBOX — see
 *     migrations/0003_mailbox_message_limit.sql for why a database trigger
 *     is used instead of an application-level count-then-insert (which is
 *     race-prone under concurrent delivery).
 *   - DuplicateMessageError: this exact (mailbox_id, message_id) was
 *     already stored — almost always a retried delivery of a message this
 *     mailbox already has. The caller should treat this as a successful,
 *     idempotent no-op, not an error to surface.
 *
 * Any other failure is rethrown unchanged as a genuine, unexpected error.
 */
export async function createMessageWithAttachments(
  env: Env,
  messageInput: CreateMessageInput,
  attachmentInputs: CreateAttachmentInput[]
): Promise<CreateMessageWithAttachmentsResult> {
  const messageId = generateId();
  const now = Date.now();

  const messageStatement = env.DB.prepare(
    `INSERT INTO messages
       (id, mailbox_id, message_id, sender_name, sender_address, recipient_address,
        subject, text_body, html_body, created_at, size_bytes, has_attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    messageId,
    messageInput.mailboxId,
    messageInput.messageId,
    messageInput.senderName,
    messageInput.senderAddress,
    messageInput.recipientAddress,
    messageInput.subject,
    messageInput.textBody,
    messageInput.htmlBody,
    now,
    messageInput.sizeBytes,
    messageInput.hasAttachments ? 1 : 0
  );

  const attachmentRows: AttachmentRow[] = attachmentInputs.map((a) => ({
    id: generateId(),
    message_id: messageId,
    filename: a.filename,
    content_type: a.contentType,
    size_bytes: a.sizeBytes,
    r2_key: a.r2Key,
    created_at: now,
  }));

  const attachmentStatements = attachmentRows.map((row) =>
    env.DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, row.message_id, row.filename, row.content_type, row.size_bytes, row.r2_key, row.created_at)
  );

  try {
    await env.DB.batch([messageStatement, ...attachmentStatements]);
  } catch (err) {
    if (isMailboxFullError(err)) throw new MailboxFullError(messageInput.mailboxId);
    if (isMessageUniqueConstraintError(err)) {
      throw new DuplicateMessageError(messageInput.mailboxId, messageInput.messageId ?? "(none)");
    }
    throw err;
  }

  const message: MessageRow = {
    id: messageId,
    mailbox_id: messageInput.mailboxId,
    message_id: messageInput.messageId,
    sender_name: messageInput.senderName,
    sender_address: messageInput.senderAddress,
    recipient_address: messageInput.recipientAddress,
    subject: messageInput.subject,
    text_body: messageInput.textBody,
    html_body: messageInput.htmlBody,
    created_at: now,
    size_bytes: messageInput.sizeBytes,
    has_attachments: messageInput.hasAttachments ? 1 : 0,
  };

  return { message, attachments: attachmentRows };
}

/** Look up an existing message by (mailbox_id, message_id) — used to detect and read back a duplicate delivery. */
export async function getMessageByMailboxAndMessageId(
  env: Env,
  mailboxId: string,
  messageId: string
): Promise<MessageRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM messages WHERE mailbox_id = ? AND message_id = ?`)
    .bind(mailboxId, messageId)
    .first<MessageRow>();
  return row ?? null;
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

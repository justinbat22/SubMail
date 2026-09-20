import { Hono } from "hono";
import type {
  AttachmentDto,
  Env,
  MessageDetailDto,
  MessageRow,
  MessageSummaryDto,
} from "../types/index.js";
import { apiError, ok } from "../lib/response.js";
import { requireMailboxAuth } from "../lib/auth.js";
import {
  deleteMessageCascade,
  getMessageForMailbox,
  listAttachmentsForMessage,
  listMessagesForMailbox,
} from "../db/messages.js";
import { actorKeyFromRequest, checkRateLimit, RATE_LIMITS } from "../lib/rate-limit.js";

export const messageRoutes = new Hono<{ Bindings: Env }>();

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function toSummaryDto(row: MessageRow): MessageSummaryDto {
  return {
    id: row.id,
    senderName: row.sender_name,
    senderAddress: row.sender_address,
    subject: row.subject,
    createdAt: row.created_at,
    hasAttachments: row.has_attachments === 1,
    sizeBytes: row.size_bytes,
  };
}

/** GET /api/mailbox/messages?limit=&offset= — paginated, newest first. */
messageRoutes.get("/", requireMailboxAuth, async (c) => {
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.MESSAGE_LIST.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.MESSAGE_LIST);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const mailbox = c.get("mailbox");

  const limitParam = Number(c.req.query("limit") ?? DEFAULT_PAGE_SIZE);
  const offsetParam = Number(c.req.query("offset") ?? 0);
  if (!Number.isFinite(limitParam) || !Number.isFinite(offsetParam) || limitParam < 1 || offsetParam < 0) {
    return apiError("INVALID_REQUEST", "limit and offset must be non-negative numbers.");
  }
  const limit = Math.min(limitParam, MAX_PAGE_SIZE);

  const rows = await listMessagesForMailbox(c.env, mailbox.id, { limit, offset: offsetParam });
  return ok({ messages: rows.map(toSummaryDto) });
});

/** GET /api/mailbox/messages/:id — full message detail, including attachment metadata. */
messageRoutes.get("/:id", requireMailboxAuth, async (c) => {
  const mailbox = c.get("mailbox");
  const messageId = c.req.param("id");
  if (!messageId) {
    return apiError("INVALID_REQUEST", "Message id is required.");
  }

  const message = await getMessageForMailbox(c.env, mailbox.id, messageId);
  if (!message) {
    return apiError("MESSAGE_NOT_FOUND", "Message not found.");
  }

  const attachmentRows = await listAttachmentsForMessage(c.env, message.id);
  const attachments: AttachmentDto[] = attachmentRows.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.content_type,
    sizeBytes: a.size_bytes,
  }));

  const dto: MessageDetailDto = {
    ...toSummaryDto(message),
    recipientAddress: message.recipient_address,
    textBody: message.text_body,
    htmlBody: message.html_body,
    attachments,
  };

  return ok(dto);
});

/** DELETE /api/mailbox/messages/:id */
messageRoutes.delete("/:id", requireMailboxAuth, async (c) => {
  const mailbox = c.get("mailbox");
  const messageId = c.req.param("id");
  if (!messageId) {
    return apiError("INVALID_REQUEST", "Message id is required.");
  }

  const deleted = await deleteMessageCascade(c.env, mailbox.id, messageId);
  if (!deleted) {
    return apiError("MESSAGE_NOT_FOUND", "Message not found.");
  }

  return ok({ deleted: true });
});

import PostalMime from "postal-mime";
import type { Email as ParsedEmail, Attachment as ParsedAttachment } from "postal-mime";
import { sanitizeEmailHtml } from "../lib/html-sanitize.js";
import {
  assertMimeStructureWithinLimits,
  withParseTimeout,
  truncate,
  DEFAULT_MIME_GUARD_LIMITS,
  MimeStructureLimitError,
  MAX_SUBJECT_LENGTH,
  MAX_SENDER_NAME_LENGTH,
  type MimeGuardLimits,
} from "../lib/mime-guards.js";

export interface NormalizedAttachment {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  content: Uint8Array;
}

export interface NormalizedEmail {
  messageId: string | null;
  senderName: string | null;
  senderAddress: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: NormalizedAttachment[];
}

export class EmailParseError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "EmailParseError";
  }
}

/**
 * Parse a raw RFC 5322 message into a normalized, application-level shape.
 *
 * Untrusted-input hardening, in order:
 *  1. Cheap structural pre-checks on the raw bytes (header block size, MIME
 *     part count, nested-message count) — see src/lib/mime-guards.ts for
 *     why these exist: postal-mime itself exposes no such limits.
 *  2. The actual parse is raced against a wall-clock timeout, so even an
 *     input that passed the structural pre-checks but still triggers
 *     pathological parse time is bounded rather than eating the Worker's
 *     entire CPU budget.
 *  3. Extracted text fields are treated as inert data (strings stored in
 *     D1, never executed) and length-capped; HTML additionally goes through
 *     the defense-in-depth sanitizer.
 *
 * Any failure at any of these stages — structural rejection, timeout, or a
 * genuine postal-mime parse exception — is surfaced as the single
 * EmailParseError type, so callers have exactly one failure mode to handle
 * (safe discard), not several.
 */
export async function parseRawEmail(
  raw: Uint8Array,
  limits: MimeGuardLimits = DEFAULT_MIME_GUARD_LIMITS
): Promise<NormalizedEmail> {
  try {
    assertMimeStructureWithinLimits(raw, limits);
  } catch (err) {
    if (err instanceof MimeStructureLimitError) {
      throw new EmailParseError(err.message, err);
    }
    throw err;
  }

  let parsed: ParsedEmail;
  try {
    parsed = await withParseTimeout(PostalMime.parse(raw), limits.parseTimeoutMs);
  } catch (err) {
    throw new EmailParseError("Failed to parse MIME message.", err);
  }

  const sender = parsed.from;
  const subject = parsed.subject ? truncate(parsed.subject, MAX_SUBJECT_LENGTH) : null;
  const senderName = sender?.name?.trim() ? truncate(sender.name.trim(), MAX_SENDER_NAME_LENGTH) : null;

  return {
    messageId: parsed.messageId ?? null,
    senderName,
    senderAddress: sender?.address?.trim().toLowerCase() || null,
    subject,
    textBody: parsed.text ?? null,
    htmlBody: parsed.html ? sanitizeEmailHtml(parsed.html) : null,
    attachments: parsed.attachments.map(normalizeAttachment),
  };
}

function normalizeAttachment(attachment: ParsedAttachment): NormalizedAttachment {
  const content = toUint8Array(attachment.content, attachment.encoding);
  return {
    filename: attachment.filename,
    contentType: attachment.mimeType || "application/octet-stream",
    sizeBytes: content.byteLength,
    content,
  };
}

function toUint8Array(content: ArrayBuffer | Uint8Array | string, encoding?: "base64" | "utf8"): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // String content: encoding tells us how to interpret it.
  if (encoding === "base64") {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(content);
}

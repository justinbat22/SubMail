import PostalMime from "postal-mime";
import type { Email as ParsedEmail, Attachment as ParsedAttachment } from "postal-mime";
import { sanitizeEmailHtml } from "../lib/html-sanitize.js";

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
 * Deliberately conservative about what it trusts from the parsed structure:
 * headers, subject, and body are all attacker-controlled and are passed
 * through as inert data (strings stored in D1, never executed), with HTML
 * additionally passed through the defense-in-depth sanitizer. Parsing
 * failures are caught and surfaced as a typed error rather than throwing a
 * raw exception into the email() handler, so a malformed message can be
 * safely discarded instead of crashing message processing.
 */
export async function parseRawEmail(raw: Uint8Array): Promise<NormalizedEmail> {
  let parsed: ParsedEmail;
  try {
    parsed = await PostalMime.parse(raw);
  } catch (err) {
    throw new EmailParseError("Failed to parse MIME message.", err);
  }

  const sender = parsed.from;

  return {
    messageId: parsed.messageId ?? null,
    senderName: sender?.name?.trim() || null,
    senderAddress: sender?.address?.trim().toLowerCase() || null,
    subject: parsed.subject ?? null,
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

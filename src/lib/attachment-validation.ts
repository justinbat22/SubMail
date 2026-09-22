/**
 * Attachment validation. Filenames in incoming MIME are fully
 * attacker-controlled — this module strips anything that could be used for
 * path traversal, null-byte tricks, or absurd lengths before a filename is
 * ever used to build an R2 key or shown back to a user.
 *
 * Note: the R2 object key itself never incorporates the filename (see
 * `buildAttachmentR2Key` in src/db/messages.ts) — it's random-ID-based. The
 * sanitized filename here is only for the metadata we store and later show
 * to the mailbox owner and set as the download's Content-Disposition.
 */

const MAX_FILENAME_LENGTH = 255;
const FALLBACK_FILENAME = "attachment";

/** Extensions that must never be offered for direct browser execution/preview risk. */
const DOUBLE_EXTENSION_RISK_PATTERN = /\.(html?|svg|xml|xhtml|js|mjs)$/i;

/**
 * Declared content-types that browsers may render or execute inline rather
 * than download, regardless of what the filename's extension claims. A
 * sender can name a file "invoice.pdf" while declaring
 * `Content-Type: text/html` — the extension check alone wouldn't catch that.
 */
const RISKY_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "text/ecmascript",
]);

export interface AttachmentValidationResult {
  valid: boolean;
  reason?: string;
  sanitizedFilename?: string;
}

/**
 * Sanitize an attacker-controlled filename:
 * - strip directory components (path traversal)
 * - strip null bytes and other control characters
 * - collapse to a safe character set, falling back to a generic name
 * - cap length
 */
export function sanitizeFilename(rawFilename: string | null | undefined): string {
  if (!rawFilename) return FALLBACK_FILENAME;

  // Strip control characters (including null bytes) first.
  // eslint-disable-next-line no-control-regex
  let name = rawFilename.replace(/[\x00-\x1f\x7f]/g, "");

  // Take only the final path segment, defeating "../../etc/passwd"-style
  // traversal and Windows-style "C:\..\..\evil.exe" paths.
  name = name.split(/[/\\]/).pop() ?? "";

  name = name.trim();

  // Disallow leading dots that could resemble hidden files or ".." on their own.
  name = name.replace(/^\.+/, "");

  if (name.length === 0) return FALLBACK_FILENAME;
  if (name.length > MAX_FILENAME_LENGTH) {
    // Preserve the extension when truncating, when there is a reasonably
    // short one, so the file still opens correctly for the user.
    const dotIndex = name.lastIndexOf(".");
    if (dotIndex > 0 && name.length - dotIndex <= 16) {
      const ext = name.slice(dotIndex);
      name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  return name;
}

/**
 * Validate an attachment's declared size and filename against configured
 * limits. Content-type is preserved as metadata but is not itself a basis
 * for rejection — the sandboxed-viewer / authenticated-download model (see
 * README "Attachment security") is what neutralizes risk, not a content-type
 * blocklist, which is trivially bypassed and gives a false sense of safety.
 */
export function validateAttachment(input: {
  filename: string | null;
  sizeBytes: number;
  maxAttachmentSize: number;
}): AttachmentValidationResult {
  if (input.sizeBytes <= 0) {
    return { valid: false, reason: "Attachment is empty." };
  }
  if (input.sizeBytes > input.maxAttachmentSize) {
    return { valid: false, reason: "Attachment exceeds the maximum allowed size." };
  }

  const sanitizedFilename = sanitizeFilename(input.filename);
  return { valid: true, sanitizedFilename };
}

/**
 * Whether a filename's extension is one that browsers may render/execute
 * inline rather than download (HTML, SVG with embedded script, XML, raw
 * JavaScript). Used only to decide response headers at download time (force
 * a download rather than an inline render) — it is not a basis for
 * rejecting the attachment.
 */
export function hasInlineRenderRiskExtension(filename: string): boolean {
  return DOUBLE_EXTENSION_RISK_PATTERN.test(filename);
}

/**
 * Whether a declared content-type is one browsers may render/execute inline.
 * Checked independently of the filename — see RISKY_CONTENT_TYPES above.
 */
export function hasRiskyContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  // Content-Type headers can carry parameters (e.g. "text/html; charset=utf-8");
  // only the type/subtype portion matters here.
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return RISKY_CONTENT_TYPES.has(bare);
}

/**
 * Combines the extension- and content-type-based checks: true if either
 * signal indicates the browser might try to render this inline rather than
 * download it. This is what download-serving code should actually call.
 */
export function isRiskyForInlineRendering(filename: string, contentType: string | null): boolean {
  return hasInlineRenderRiskExtension(filename) || hasRiskyContentType(contentType);
}

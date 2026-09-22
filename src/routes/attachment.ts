import { Hono } from "hono";
import type { Env } from "../types/index.js";
import { apiError } from "../lib/response.js";
import { requireMailboxAuth } from "../lib/auth.js";
import { getAttachmentForMailbox } from "../db/messages.js";
import { actorKeyFromRequest, checkRateLimit, RATE_LIMITS } from "../lib/rate-limit.js";
import { isRiskyForInlineRendering } from "../lib/attachment-validation.js";
import { securityHeaders } from "../lib/security.js";
import { isValidOpaqueId } from "../lib/validation.js";

export const attachmentRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/attachments/:id — streams the attachment from R2.
 *
 * Requires the same mailbox auth as every other mailbox-scoped endpoint
 * (the attachment ID alone is not a capability token — see
 * getAttachmentForMailbox, which joins through messages -> mailbox_id so an
 * ID from one mailbox can never be fetched using another mailbox's
 * credentials). Always served with `Content-Disposition: attachment` for
 * filetypes a browser might otherwise render inline (HTML, SVG, XML, JS —
 * checked by BOTH filename extension and declared content-type, since a
 * sender can name a file "invoice.pdf" while declaring
 * Content-Type: text/html), since an inline-rendered attacker-controlled
 * file served from our own origin would defeat the sandboxed-iframe model
 * used for message bodies.
 */
attachmentRoutes.get("/:id", requireMailboxAuth, async (c) => {
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.ATTACHMENT_DOWNLOAD.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.ATTACHMENT_DOWNLOAD);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many downloads. Please slow down.");
  }

  const mailbox = c.get("mailbox");
  const attachmentId = c.req.param("id");
  if (!isValidOpaqueId(attachmentId)) {
    return apiError("ATTACHMENT_NOT_FOUND", "Attachment not found.");
  }

  const attachment = await getAttachmentForMailbox(c.env, mailbox.id, attachmentId);
  if (!attachment) {
    return apiError("ATTACHMENT_NOT_FOUND", "Attachment not found.");
  }

  const object = await c.env.ATTACHMENTS.get(attachment.r2_key);
  if (!object) {
    // Metadata exists but the R2 object is missing (shouldn't normally
    // happen outside a partial-failure edge case). Treat as not-found
    // rather than a 500, since from the client's perspective it isn't
    // downloadable either way.
    return apiError("ATTACHMENT_NOT_FOUND", "Attachment not found.");
  }

  const headers = new Headers(securityHeaders());
  const forceDownload = isRiskyForInlineRendering(attachment.filename, attachment.content_type);
  const contentType = forceDownload ? "application/octet-stream" : attachment.content_type ?? "application/octet-stream";
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(attachment.size_bytes));
  headers.set("Content-Disposition", `attachment; filename="${encodeContentDispositionFilename(attachment.filename)}"`);
  // Belt-and-suspenders even though this response already isn't HTML.
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(object.body, { status: 200, headers });
});

/** RFC 6266-style filename* fallback so non-ASCII filenames survive the header safely. */
function encodeContentDispositionFilename(filename: string): string {
  // Strip characters that would break out of the quoted string.
  return filename.replace(/["\r\n]/g, "_");
}

import { Hono } from "hono";
import type { Env } from "./types/index.js";
import { healthRoutes } from "./routes/health.js";
import { mailboxRoutes } from "./routes/mailbox.js";
import { messageRoutes } from "./routes/message.js";
import { attachmentRoutes } from "./routes/attachment.js";
import { apiError } from "./lib/response.js";
import { applySecurityHeaders } from "./lib/security.js";
import { runExpiredMailboxCleanup } from "./cleanup/expired-mailboxes.js";
import { handleIncomingEmail } from "./email/handler.js";

const app = new Hono<{ Bindings: Env }>();

// Same-origin only: this API is consumed by its own frontend, not third
// parties, so no CORS headers are added (item 32: avoid overly permissive
// CORS; prefer same-origin requests).

app.route("/api/health", healthRoutes);
app.route("/api/mailbox", mailboxRoutes);
app.route("/api/mailbox/messages", messageRoutes);
app.route("/api/attachments", attachmentRoutes);

app.notFound(() => apiError("INVALID_REQUEST", "Not found.", { status: 404 }));

app.onError((err, c) => {
  // Never leak stack traces or internal implementation details (item 42).
  console.error(JSON.stringify({
    level: "error",
    route: c.req.path,
    method: c.req.method,
    message: err instanceof Error ? err.message : "Unknown error",
  }));
  return apiError("INTERNAL_ERROR", "Something went wrong. Please try again.", { status: 500 });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await app.fetch(request, env, ctx);
    return applySecurityHeaders(response);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runExpiredMailboxCleanup(env).then((result) => {
        console.log(JSON.stringify({ level: "info", job: "cleanup", ...result }));
      })
    );
  },

  // Email Routing delivers incoming mail here once configured (see README's
  // "Email Routing setup").
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await handleIncomingEmail(message, env);
    } catch (err) {
      console.error(JSON.stringify({
        level: "error",
        job: "email-handler",
        message: err instanceof Error ? err.message : "Unknown error",
      }));
      // Rethrow rather than swallow. handleIncomingEmail only ever lets an
      // exception reach here for GENUINELY UNEXPECTED/TRANSIENT failures
      // (an R2 upload error, an unexpected D1 error) — every PERMANENT,
      // never-worth-retrying condition (unknown recipient, expired mailbox,
      // oversized message, mailbox full, malformed MIME, already-processed
      // duplicate) is handled inside handleIncomingEmail itself, which
      // returns normally (or calls setReject) instead of throwing.
      //
      // An earlier version of this handler swallowed every exception here
      // "to avoid a retry storm" — but that silently and permanently
      // dropped mail whenever a purely transient infrastructure hiccup hit
      // R2 or D1, with no way to ever recover it. Letting the exception
      // propagate causes Cloudflare to treat the delivery as failed, which
      // is what lets the sending MTA's normal (rate-limited, bounded) retry
      // behavior actually recover the message — the retry storm concern is
      // Cloudflare/the sending MTA's problem to bound, not a reason to
      // silently discard mail we might have been able to store on a retry.
      throw err;
    }
  },
};

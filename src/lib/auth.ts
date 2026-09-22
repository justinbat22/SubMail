import type { Context, Next } from "hono";
import type { Env, MailboxRow } from "../types/index.js";
import { getMailboxById } from "../db/mailboxes.js";
import { verifyToken } from "./token.js";
import { apiError } from "./response.js";
import { isValidOpaqueId } from "./validation.js";
import { actorKeyFromRequest, checkRateLimit, RATE_LIMITS } from "./rate-limit.js";

/**
 * Mailbox-scoped auth: the client presents the mailbox ID (X-Mailbox-Id
 * header) and its secret access token (Authorization: Bearer <token>). The
 * email address itself is never treated as a credential (item 12).
 *
 * On success, attaches the authenticated mailbox row to the request context
 * under "mailbox" for downstream handlers.
 */
export async function requireMailboxAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  // Rate-limited here, inside the shared middleware, rather than per-route:
  // this bounds credential-guessing attempts against *every* authenticated
  // endpoint uniformly, including ones with no route-specific limit of their
  // own (e.g. GET /api/mailbox), closing a gap that per-route limits alone
  // would leave open (spec §16: rate limits must not be bypassable via an
  // alternative route).
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.AUTH_ATTEMPT.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.AUTH_ATTEMPT);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const mailboxId = c.req.header("X-Mailbox-Id");
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!mailboxId || !token) {
    return apiError("UNAUTHORIZED", "Missing mailbox credentials.");
  }

  // Validate shape before touching the database: every mailbox ID this app
  // issues is exactly 32 lowercase hex characters (see generateMailboxId).
  // Anything else can only ever be "not found" — rejecting it here avoids a
  // wasted D1 round-trip on obviously-malformed input, and returns the exact
  // same response as a well-formed-but-nonexistent ID, so the ID's expected
  // shape can't be probed for either.
  if (!isValidOpaqueId(mailboxId)) {
    return apiError("UNAUTHORIZED", "Invalid mailbox credentials.");
  }

  const mailbox = await getMailboxById(c.env, mailboxId);
  if (!mailbox) {
    // Deliberately identical error to a bad token, so this endpoint cannot
    // be used to enumerate valid mailbox IDs.
    return apiError("UNAUTHORIZED", "Invalid mailbox credentials.");
  }

  const validToken = await verifyToken(token, mailbox.token_hash);
  if (!validToken) {
    return apiError("UNAUTHORIZED", "Invalid mailbox credentials.");
  }

  if (mailbox.expires_at <= Date.now()) {
    return apiError("UNAUTHORIZED", "This mailbox has expired.");
  }

  c.set("mailbox", mailbox);
  await next();
}

declare module "hono" {
  interface ContextVariableMap {
    mailbox: MailboxRow;
  }
}

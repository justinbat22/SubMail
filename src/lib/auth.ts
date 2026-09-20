import type { Context, Next } from "hono";
import type { Env, MailboxRow } from "../types/index.js";
import { getMailboxById } from "../db/mailboxes.js";
import { verifyToken } from "./token.js";
import { apiError } from "./response.js";

/**
 * Mailbox-scoped auth: the client presents the mailbox ID (X-Mailbox-Id
 * header) and its secret access token (Authorization: Bearer <token>). The
 * email address itself is never treated as a credential (item 12).
 *
 * On success, attaches the authenticated mailbox row to the request context
 * under "mailbox" for downstream handlers.
 */
export async function requireMailboxAuth(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const mailboxId = c.req.header("X-Mailbox-Id");
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  if (!mailboxId || !token) {
    return apiError("UNAUTHORIZED", "Missing mailbox credentials.");
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

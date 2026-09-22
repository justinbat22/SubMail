import { Hono } from "hono";
import type { Env, MailboxCreatedDto, MailboxDto } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { apiError, created, ok } from "../lib/response.js";
import { requireMailboxAuth } from "../lib/auth.js";
import {
  createMailbox,
  deleteMailboxCascade,
  isAddressTaken,
  makeD1UniquenessChecker,
} from "../db/mailboxes.js";
import { generateMailboxToken, hashToken } from "../lib/token.js";
import { generateUniqueUsername, UsernameCollisionError } from "../lib/username-generator.js";
import { buildAddress, normalizeLocalPart, validateCustomLocalPart } from "../lib/validation.js";
import { actorKeyFromRequest, checkRateLimit, RATE_LIMITS } from "../lib/rate-limit.js";
import { parseOptionalJsonObject } from "../lib/request-body.js";

export const mailboxRoutes = new Hono<{ Bindings: Env }>();

function toMailboxDto(row: { id: string; address: string; created_at: number }): MailboxDto {
  return { id: row.id, address: row.address, createdAt: row.created_at };
}

/**
 * POST /api/mailbox
 * Body: {} for an auto-generated address, or { "localPart": "mytest123" }
 * for a user-chosen one. Returns the mailbox plus its one-time access token.
 */
mailboxRoutes.post("/", async (c) => {
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.MAILBOX_CREATE.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.MAILBOX_CREATE);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many mailboxes created. Please try again later.");
  }

  const config = loadConfig(c.env);

  const bodyResult = await parseOptionalJsonObject(c.req.raw);
  if (!bodyResult.ok) {
    return apiError("INVALID_REQUEST", bodyResult.message);
  }

  let requestedLocalPart: string | undefined;
  if ("localPart" in bodyResult.value) {
    const value = bodyResult.value.localPart;
    if (value !== undefined && typeof value !== "string") {
      return apiError("INVALID_REQUEST", "localPart must be a string.");
    }
    requestedLocalPart = value as string | undefined;
  }

  let localPart: string;

  if (requestedLocalPart) {
    const validation = validateCustomLocalPart(requestedLocalPart);
    if (!validation.valid) {
      const code = validation.reason === "This name is reserved." ? "RESERVED_NAME" : "INVALID_REQUEST";
      return apiError(code, validation.reason ?? "Invalid local part.");
    }
    const normalized = normalizeLocalPart(requestedLocalPart);
    const address = buildAddress(normalized, config.emailDomain);
    if (await isAddressTaken(c.env, address)) {
      return apiError("NAME_UNAVAILABLE", "This email address is already taken.");
    }
    localPart = normalized;
  } else {
    try {
      const checker = makeD1UniquenessChecker(c.env, config.emailDomain);
      const { localPart: generated } = await generateUniqueUsername(checker);
      localPart = generated;
    } catch (err) {
      if (err instanceof UsernameCollisionError) {
        return apiError("INTERNAL_ERROR", "Could not allocate a mailbox address. Please try again.");
      }
      throw err;
    }
  }

  const address = buildAddress(localPart, config.emailDomain);
  const token = generateMailboxToken();
  const tokenHash = await hashToken(token);

  try {
    const mailbox = await createMailbox(c.env, {
      localPart,
      domain: config.emailDomain,
      address,
      tokenHash,
      ttlHours: config.mailboxTtlHours,
    });

    const dto: MailboxCreatedDto = { ...toMailboxDto(mailbox), token };
    return created(dto);
  } catch (err) {
    // The D1 UNIQUE constraint is authoritative; a rare race on a
    // user-chosen name surfaces here as a normal "taken" response rather
    // than a 500, since it is an expected, benign outcome under concurrency.
    if (err instanceof Error && err.name === "MailboxAddressTakenError") {
      return apiError("NAME_UNAVAILABLE", "This email address is already taken.");
    }
    throw err;
  }
});

/** GET /api/mailbox — fetch the authenticated mailbox's own public info. */
mailboxRoutes.get("/", requireMailboxAuth, (c) => {
  const mailbox = c.get("mailbox");
  return ok(toMailboxDto(mailbox));
});

/**
 * GET /api/mailbox/check?localPart=mytest123
 * Rate-limited to deter enumeration (item 10).
 */
mailboxRoutes.get("/check", async (c) => {
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.MAILBOX_CHECK.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.MAILBOX_CHECK);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many availability checks. Please slow down.");
  }

  const localPart = c.req.query("localPart");
  if (!localPart) {
    return apiError("INVALID_REQUEST", "localPart query parameter is required.");
  }

  const validation = validateCustomLocalPart(localPart);
  if (!validation.valid) {
    return ok({ available: false, reason: validation.reason });
  }

  const config = loadConfig(c.env);
  const address = buildAddress(localPart, config.emailDomain);
  const taken = await isAddressTaken(c.env, address);

  return ok({ available: !taken });
});

/** DELETE /api/mailbox — immediately delete the authenticated mailbox and everything under it. */
mailboxRoutes.delete("/", requireMailboxAuth, async (c) => {
  const actorKey = await actorKeyFromRequest(c.req.raw, RATE_LIMITS.MAILBOX_DELETE.bucket);
  const rate = await checkRateLimit(c.env, actorKey, RATE_LIMITS.MAILBOX_DELETE);
  if (!rate.allowed) {
    return apiError("RATE_LIMITED", "Too many delete requests. Please try again later.");
  }

  const mailbox = c.get("mailbox");
  await deleteMailboxCascade(c.env, mailbox.id);
  return ok({ deleted: true });
});

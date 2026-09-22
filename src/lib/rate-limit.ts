import type { Env } from "../types/index.js";

export interface RateLimitConfig {
  /** Logical bucket name, e.g. "mailbox:create" or "mailbox:check". */
  bucket: string;
  /** Maximum number of requests allowed per window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/**
 * A privacy-conscious actor key: the connecting IP is hashed (never stored
 * or logged in plaintext) and combined with the bucket name, so the raw
 * address never touches D1 or application logs (see item 33/34: no
 * unnecessary personal data, and never log more than necessary).
 */
export async function actorKeyFromRequest(request: Request, bucket: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const hashHex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32); // truncated — this is a bucketing key, not a security secret
  return `${bucket}:${hashHex}`;
}

/**
 * Increment and check a fixed-window counter stored in D1.
 *
 * Fixed windows are simpler and cheaper than sliding-window or token-bucket
 * schemes and are sufficient here: the goal is blunting abuse (enumeration,
 * flooding), not precise per-second fairness. A single UPSERT keeps this
 * race-safe under concurrent requests, mirroring the same "let the database
 * constraint be authoritative" principle used for mailbox creation.
 */
export async function checkRateLimit(
  env: Env,
  actorKey: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / config.windowMs) * config.windowMs;
  const key = `${actorKey}`;

  const result = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(key, windowStart)
    .first<{ count: number }>();

  const count = result?.count ?? 1;
  const resetAt = windowStart + config.windowMs;

  return {
    allowed: count <= config.limit,
    remaining: Math.max(0, config.limit - count),
    resetAt,
  };
}

/** Delete rate-limit rows for windows that have fully elapsed, in bounded batches. */
export async function cleanupExpiredRateLimitWindows(env: Env, olderThanMs: number, limit = 500): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const rows = await env.DB.prepare(
    `SELECT rowid FROM rate_limits WHERE window_start < ? LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ rowid: number }>();

  const rowids = (rows.results ?? []).map((r) => r.rowid);
  if (rowids.length === 0) return 0;

  const placeholders = rowids.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM rate_limits WHERE rowid IN (${placeholders})`)
    .bind(...rowids)
    .run();

  return rowids.length;
}

/** Common named limits used across routes. Centralized so tuning is a one-line change. */
export const RATE_LIMITS = {
  MAILBOX_CREATE: { bucket: "mailbox:create", limit: 10, windowMs: 60 * 60 * 1000 } satisfies RateLimitConfig,
  MAILBOX_CHECK: { bucket: "mailbox:check", limit: 30, windowMs: 60 * 1000 } satisfies RateLimitConfig,
  MAILBOX_DELETE: { bucket: "mailbox:delete", limit: 20, windowMs: 60 * 60 * 1000 } satisfies RateLimitConfig,
  MESSAGE_LIST: { bucket: "message:list", limit: 120, windowMs: 60 * 1000 } satisfies RateLimitConfig,
  ATTACHMENT_DOWNLOAD: { bucket: "attachment:download", limit: 60, windowMs: 60 * 1000 } satisfies RateLimitConfig,
  /**
   * Applied inside requireMailboxAuth itself (src/lib/auth.ts), so it covers
   * every authenticated route uniformly — not just the routes that happen to
   * add their own extra limit on top. This closes the gap where a route with
   * no route-specific limit (e.g. GET /api/mailbox) would otherwise allow
   * unlimited credential-guessing attempts.
   */
  AUTH_ATTEMPT: { bucket: "auth:attempt", limit: 60, windowMs: 60 * 1000 } satisfies RateLimitConfig,
} as const;

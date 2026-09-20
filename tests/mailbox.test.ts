import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
// Vite's `?raw` suffix inlines the file's contents as a string at build
// time. This runs inside the actual Workers runtime (workerd), which has no
// Node `fs` module, so migrations can't be read from disk at test time —
// this is the same schema that ships to production, just bundled in.
import initialMigrationSql from "../migrations/0001_initial.sql?raw";
import rateLimitsMigrationSql from "../migrations/0002_rate_limits.sql?raw";
import type { MailboxCreatedDto } from "../src/types/index.js";

// `env` and `SELF` are provided by @cloudflare/vitest-pool-workers, wired to
// the bindings declared in wrangler.toml + vitest.config.ts. `SELF` routes
// requests through the actual exported `fetch` handler (src/index.ts),
// exercising the real Hono app, middleware, and security headers.

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ATTACHMENTS: R2Bucket;
    EMAIL_DOMAIN: string;
    APP_URL: string;
    MAILBOX_TTL_HOURS: string;
    MAX_MESSAGE_SIZE: string;
    MAX_ATTACHMENT_SIZE: string;
    MAX_ATTACHMENTS_PER_MESSAGE: string;
    MAX_MESSAGES_PER_MAILBOX: string;
    CLEANUP_BATCH_SIZE: string;
  }
}

/**
 * Apply the real migration SQL to the simulated D1 instance, so these tests
 * run against the exact schema that ships to production rather than a
 * hand-maintained test-only copy.
 *
 * Comments are stripped line-by-line *before* splitting on ";", since a
 * comment can itself contain a semicolon (as several of ours do) — splitting
 * first would otherwise chop a comment mid-sentence into a bogus "statement".
 */
async function applyMigrationSql(sql: string): Promise<void> {
  const withoutComments = sql
    .split("\n")
    .map((line) => (line.trim().startsWith("--") ? "" : line))
    .join("\n");

  const statements = withoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

beforeAll(async () => {
  await applyMigrationSql(initialMigrationSql);
  await applyMigrationSql(rateLimitsMigrationSql);
});

beforeEach(async () => {
  // Reset tables between tests for isolation.
  await env.DB.exec("DELETE FROM attachments;");
  await env.DB.exec("DELETE FROM messages;");
  await env.DB.exec("DELETE FROM mailboxes;");
  await env.DB.exec("DELETE FROM rate_limits;");
});

async function createAutoMailbox(): Promise<MailboxCreatedDto> {
  const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { success: true; data: MailboxCreatedDto };
  return body.data;
}

describe("POST /api/mailbox (auto-generated)", () => {
  it("creates a mailbox with a human-looking address and a token", async () => {
    const mailbox = await createAutoMailbox();
    expect(mailbox.address).toMatch(/^[a-z0-9.]+@example\.com$/);
    expect(mailbox.token.length).toBeGreaterThan(20);
    expect(mailbox.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("creates distinct addresses across repeated calls", async () => {
    const a = await createAutoMailbox();
    const b = await createAutoMailbox();
    expect(a.address).not.toBe(b.address);
  });
});

describe("POST /api/mailbox (custom local-part)", () => {
  it("creates a mailbox with the requested local-part", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "mytest123" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: true; data: MailboxCreatedDto };
    expect(body.data.address).toBe("mytest123@example.com");
  });

  it("rejects a reserved local-part", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "admin" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: false; error: { code: string } };
    expect(body.error.code).toBe("RESERVED_NAME");
  });

  it("rejects a duplicate local-part", async () => {
    await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "taken123" }),
    });
    const res2 = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "taken123" }),
    });
    expect(res2.status).toBe(409);
    const body = (await res2.json()) as { success: false; error: { code: string } };
    expect(body.error.code).toBe("NAME_UNAVAILABLE");
  });

  it("rejects malformed/unsafe local-parts", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "<script>alert(1)</script>" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/mailbox/check", () => {
  it("reports an unused name as available", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=freshname99");
    const body = (await res.json()) as { success: true; data: { available: boolean } };
    expect(body.data.available).toBe(true);
  });

  it("reports a reserved name as unavailable", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=admin");
    const body = (await res.json()) as { success: true; data: { available: boolean } };
    expect(body.data.available).toBe(false);
  });

  it("reports a taken name as unavailable", async () => {
    await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "alreadyhere" }),
    });
    const res = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=alreadyhere");
    const body = (await res.json()) as { success: true; data: { available: boolean } };
    expect(body.data.available).toBe(false);
  });
});

describe("Mailbox authentication", () => {
  it("rejects requests with no credentials", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid mailbox ID", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer sometoken", "X-Mailbox-Id": "0".repeat(32) },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token for a real mailbox", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer wrong-token", "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid mailbox ID + token pair", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: true; data: { address: string } };
    expect(body.data.address).toBe(mailbox.address);
  });

  it("never accepts the address itself as a credential", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: `Bearer ${mailbox.address}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/mailbox", () => {
  it("immediately deletes the mailbox and invalidates its token", async () => {
    const mailbox = await createAutoMailbox();
    const authHeaders = { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id };

    const del = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(del.status).toBe(200);

    const after = await SELF.fetch("https://app.example.com/api/mailbox", { headers: authHeaders });
    expect(after.status).toBe(401);
  });

  it("frees the local-part for immediate reuse after deletion", async () => {
    const created1 = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "reusable1" }),
    });
    const mailbox = ((await created1.json()) as { data: MailboxCreatedDto }).data;

    await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });

    const recreate = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "reusable1" }),
    });
    expect(recreate.status).toBe(201);
  });

  it("rejects deletion without valid credentials", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe("Security headers", () => {
  it("applies baseline security headers to API responses", async () => {
    const res = await SELF.fetch("https://app.example.com/api/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });
});

describe("GET /api/health", () => {
  it("returns ok without leaking infrastructure details", async () => {
    const res = await SELF.fetch("https://app.example.com/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: true; data: { status: string } };
    expect(body.data.status).toBe("ok");
    const text = JSON.stringify(body);
    expect(text.toLowerCase()).not.toContain("database");
    expect(text.toLowerCase()).not.toContain("token");
  });
});

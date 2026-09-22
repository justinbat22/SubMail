import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { MailboxCreatedDto } from "../src/types/index.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";

// `env` and `SELF` are provided by @cloudflare/vitest-pool-workers, wired to
// the bindings declared in wrangler.toml + vitest.config.ts. `SELF` routes
// requests through the actual exported `fetch` handler (src/index.ts),
// exercising the real Hono app, middleware, and security headers.

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
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
    expect(mailbox.address).toMatch(new RegExp(`^[a-z0-9.]+@${env.EMAIL_DOMAIN.replace(/\./g, "\\.")}$`));
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
    expect(body.data.address).toBe(`mytest123@${env.EMAIL_DOMAIN}`);
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

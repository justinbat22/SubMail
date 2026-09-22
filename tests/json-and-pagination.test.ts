import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { parseOptionalJsonObject } from "../src/lib/request-body.js";
import { validatePagination, parseStrictInteger, isValidOpaqueId } from "../src/lib/validation.js";
import type { MailboxCreatedDto } from "../src/types/index.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

// ---------------------------------------------------------------------------
// Unit tests: parseOptionalJsonObject
// ---------------------------------------------------------------------------

describe("parseOptionalJsonObject", () => {
  function makeRequest(body: string | undefined, contentType = "application/json"): Request {
    return new Request("https://app.example.com/x", {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": contentType } : {},
      body,
    });
  }

  it("accepts a well-formed JSON object", async () => {
    const result = await parseOptionalJsonObject(makeRequest('{"username":"example"}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ username: "example" });
  });

  it("treats a completely empty body as an empty object, not an error", async () => {
    const result = await parseOptionalJsonObject(makeRequest(undefined));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  it("treats a whitespace-only body as empty", async () => {
    const result = await parseOptionalJsonObject(makeRequest("   \n  "));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({});
  });

  it("rejects malformed JSON rather than silently becoming {}", async () => {
    const result = await parseOptionalJsonObject(makeRequest("this is not json"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/invalid json/i);
  });

  it("rejects JSON null", async () => {
    const result = await parseOptionalJsonObject(makeRequest("null"));
    expect(result.ok).toBe(false);
  });

  it("rejects a JSON array", async () => {
    const result = await parseOptionalJsonObject(makeRequest("[1,2,3]"));
    expect(result.ok).toBe(false);
  });

  it("rejects JSON primitives (number, string, boolean)", async () => {
    expect((await parseOptionalJsonObject(makeRequest("42"))).ok).toBe(false);
    expect((await parseOptionalJsonObject(makeRequest('"hello"'))).ok).toBe(false);
    expect((await parseOptionalJsonObject(makeRequest("true"))).ok).toBe(false);
  });

  it("rejects a non-empty body sent with the wrong Content-Type", async () => {
    const result = await parseOptionalJsonObject(makeRequest('{"a":1}', "text/plain"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/content-type/i);
  });

  it("tolerates unexpected/extra fields without erroring", async () => {
    const result = await parseOptionalJsonObject(makeRequest('{"localPart":"x","somethingElse":123}'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.somethingElse).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: POST /api/mailbox JSON handling
// ---------------------------------------------------------------------------

describe("POST /api/mailbox - JSON body handling (end to end)", () => {
  it("creates an auto-generated mailbox with no body at all", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
    expect(res.status).toBe(201);
  });

  it("creates an auto-generated mailbox with an empty JSON object", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
  });

  it("rejects malformed JSON with 400, and does not create a mailbox", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: false; error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("rejects a JSON array body with 400", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1,2,3]",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a JSON null body with 400", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a bare JSON primitive body with 400", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "42",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-empty body with an incorrect Content-Type", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: '{"localPart":"whatever"}',
    });
    expect(res.status).toBe(400);
  });

  it("still creates a mailbox correctly for a valid, well-formed request", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: "jsonfixvalid" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: MailboxCreatedDto };
    expect(body.data.address).toBe("jsonfixvalid@example.com");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: parseStrictInteger / validatePagination
// ---------------------------------------------------------------------------

describe("parseStrictInteger", () => {
  it("accepts plain integers", () => {
    expect(parseStrictInteger("10")).toBe(10);
    expect(parseStrictInteger("0")).toBe(0);
    expect(parseStrictInteger("-5")).toBe(-5);
  });

  it("rejects decimals", () => {
    expect(parseStrictInteger("1.5")).toBeNull();
    expect(parseStrictInteger("10.0")).toBeNull();
  });

  it("rejects NaN and non-numeric garbage", () => {
    expect(parseStrictInteger("NaN")).toBeNull();
    expect(parseStrictInteger("abc")).toBeNull();
    expect(parseStrictInteger("")).toBeNull();
  });

  it("rejects Infinity and exponent notation", () => {
    expect(parseStrictInteger("Infinity")).toBeNull();
    expect(parseStrictInteger("-Infinity")).toBeNull();
    expect(parseStrictInteger("1e5")).toBeNull();
  });

  it("rejects values with leading/trailing whitespace", () => {
    expect(parseStrictInteger(" 10")).toBeNull();
    expect(parseStrictInteger("10 ")).toBeNull();
  });
});

describe("validatePagination", () => {
  const opts = { defaultLimit: 25, maxLimit: 100 };

  it("accepts valid integers", () => {
    const result = validatePagination("10", "5", opts);
    expect(result.valid).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
  });

  it("uses defaults when limit/offset are omitted", () => {
    const result = validatePagination(undefined, undefined, opts);
    expect(result.valid).toBe(true);
    expect(result.limit).toBe(25);
    expect(result.offset).toBe(0);
  });

  it("rejects a decimal limit", () => {
    expect(validatePagination("1.5", undefined, opts).valid).toBe(false);
  });

  it("rejects a decimal offset", () => {
    expect(validatePagination(undefined, "2.5", opts).valid).toBe(false);
  });

  it("rejects NaN", () => {
    expect(validatePagination("NaN", undefined, opts).valid).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(validatePagination("Infinity", undefined, opts).valid).toBe(false);
  });

  it("rejects a negative limit", () => {
    expect(validatePagination("-1", undefined, opts).valid).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(validatePagination(undefined, "-1", opts).valid).toBe(false);
  });

  it("rejects a zero limit", () => {
    expect(validatePagination("0", undefined, opts).valid).toBe(false);
  });

  it("accepts a zero offset", () => {
    expect(validatePagination(undefined, "0", opts).valid).toBe(true);
  });

  it("rejects a limit above the configured maximum", () => {
    expect(validatePagination("1000000", undefined, opts).valid).toBe(false);
  });

  it("rejects an absurdly large offset", () => {
    expect(validatePagination(undefined, "99999999999", opts).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: GET /api/mailbox/messages pagination handling
// ---------------------------------------------------------------------------

describe("GET /api/mailbox/messages - pagination handling (end to end)", () => {
  async function createAutoMailbox(): Promise<MailboxCreatedDto> {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
    const body = (await res.json()) as { data: MailboxCreatedDto };
    return body.data;
  }

  it("accepts valid pagination", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?limit=10&offset=0", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a decimal limit with 400", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?limit=1.5", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a negative offset with 400", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?offset=-1", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(400);
  });

  it("rejects NaN-producing limit with 400", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?limit=banana", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an Infinity limit with 400", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?limit=Infinity", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a limit above the maximum page size with 400", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages?limit=99999", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(400);
  });

  it("works correctly with no pagination params at all (defaults apply)", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Opaque ID format validation
// ---------------------------------------------------------------------------

describe("isValidOpaqueId", () => {
  it("accepts a well-formed 32-char lowercase hex ID", () => {
    expect(isValidOpaqueId("0123456789abcdef0123456789abcdef")).toBe(true); // exactly 32 hex chars
  });

  it("rejects IDs that are too short or too long", () => {
    expect(isValidOpaqueId("0123456789abcdef")).toBe(false); // 16 chars
    expect(isValidOpaqueId("0123456789abcdef0123456789abcdef00")).toBe(false); // 34 chars
  });

  it("rejects uppercase hex", () => {
    expect(isValidOpaqueId("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidOpaqueId("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
  });

  it("rejects path-traversal-style and SQL-injection-style payloads", () => {
    expect(isValidOpaqueId("../../etc/passwd")).toBe(false);
    expect(isValidOpaqueId("' OR 1=1 --")).toBe(false);
  });

  it("rejects empty, undefined, and null", () => {
    expect(isValidOpaqueId("")).toBe(false);
    expect(isValidOpaqueId(undefined)).toBe(false);
    expect(isValidOpaqueId(null)).toBe(false);
  });
});

describe("Message/attachment routes reject malformed IDs consistently (end to end)", () => {
  async function createAutoMailbox(): Promise<MailboxCreatedDto> {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
    const body = (await res.json()) as { data: MailboxCreatedDto };
    return body.data;
  }

  it("GET a malformed message ID returns 404, not 500 or a stack trace", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages/' OR 1=1 --", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: false; error: { code: string; message: string } };
    expect(body.error.code).toBe("MESSAGE_NOT_FOUND");
    expect(body.error.message).not.toMatch(/sql|stack|internal/i);
  });

  it("GET a malformed attachment ID returns 404", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/attachments/../../etc/passwd", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(404);
  });

  it("DELETE a malformed message ID returns 404", async () => {
    const mailbox = await createAutoMailbox();
    const res = await SELF.fetch("https://app.example.com/api/mailbox/messages/short", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(404);
  });

  it("a malformed X-Mailbox-Id header is rejected identically to a wellformed-but-missing one", async () => {
    const malformed = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer sometoken", "X-Mailbox-Id": "not-a-valid-id" },
    });
    const wellFormedButMissing = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer sometoken", "X-Mailbox-Id": "f".repeat(32) },
    });
    expect(malformed.status).toBe(wellFormedButMissing.status);
    const [a, b] = await Promise.all([malformed.json(), wellFormedButMissing.json()]);
    expect(a).toEqual(b);
  });
});

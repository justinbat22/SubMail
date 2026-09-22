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

/** Minimal ForwardableEmailMessage test double, per @cloudflare/workers-types. */
function buildIncomingMessage(opts: {
  from: string;
  to: string;
  raw: string;
}): ForwardableEmailMessage & { rejectedWith: string | null; forwardedTo: string[] } {
  const rawBytes = new TextEncoder().encode(opts.raw);
  let rejectedWith: string | null = null;
  const forwardedTo: string[] = [];

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
    setReject(reason: string) {
      rejectedWith = reason;
    },
    async forward(rcptTo: string) {
      forwardedTo.push(rcptTo);
    },
    async reply() {
      /* not used */
    },
    get rejectedWith() {
      return rejectedWith;
    },
    get forwardedTo() {
      return forwardedTo;
    },
  } as unknown as ForwardableEmailMessage & { rejectedWith: string | null; forwardedTo: string[] };
}

function buildRawEmail(opts: { to: string; subject: string; body: string; from?: string }): string {
  return [
    `From: "Sender Person" <${opts.from ?? "sender@outside.example"}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.body,
    ``,
  ].join("\r\n");
}

async function createAutoMailbox(): Promise<MailboxCreatedDto> {
  const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
  const body = (await res.json()) as { data: MailboxCreatedDto };
  return body.data;
}

async function deliverEmail(message: ForwardableEmailMessage): Promise<void> {
  const ctx = createExecutionContext();
  await worker.email!(message, env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("email() handler - end to end", () => {
  it("stores an incoming message and makes it readable via the API", async () => {
    const mailbox = await createAutoMailbox();
    const raw = buildRawEmail({ to: mailbox.address, subject: "Welcome!", body: "Thanks for signing up." });
    const message = buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw });

    await deliverEmail(message);

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    expect(listBody.data.messages).toHaveLength(1);
    expect(listBody.data.messages[0]!.subject).toBe("Welcome!");
    expect(listBody.data.messages[0]!.senderAddress).toBe("sender@outside.example");

    const detailRes = await SELF.fetch(
      `https://app.example.com/api/mailbox/messages/${listBody.data.messages[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id } }
    );
    const detailBody = (await detailRes.json()) as { data: MessageDetailDto };
    expect(detailBody.data.textBody).toContain("Thanks for signing up.");
  });

  it("silently discards mail for an unknown recipient without creating a mailbox", async () => {
    const raw = buildRawEmail({ to: "nobody-here@example.com", subject: "hi", body: "hi" });
    const message = buildIncomingMessage({ from: "sender@outside.example", to: "nobody-here@example.com", raw });

    await deliverEmail(message);

    expect(message.rejectedWith).toBeNull();
    expect(message.forwardedTo).toHaveLength(0);

    const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("rejects an oversized message with setReject rather than storing it", async () => {
    const mailbox = await createAutoMailbox();
    // MAX_MESSAGE_SIZE in test config is inherited from wrangler.toml (10 MiB
    // default) — override via a tiny raw payload check isn't meaningful here,
    // so instead we directly verify the reject path fires when rawSize
    // exceeds the configured max, using a message whose declared rawSize
    // we inflate independent of actual byte content.
    const raw = buildRawEmail({ to: mailbox.address, subject: "big", body: "small body" });
    const message = buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw });
    // Force rawSize over the configured limit to exercise the size guard.
    Object.defineProperty(message, "rawSize", { value: 999_999_999 });

    await deliverEmail(message);

    expect(message.rejectedWith).toMatch(/too large/i);

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    expect(listBody.data.messages).toHaveLength(0);
  });

  it("stores a message with an attachment, retrievable via authenticated download", async () => {
    const mailbox = await createAutoMailbox();
    const boundary = "----=_Boundary";
    const csv = "a,b\n1,2\n";
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: With attachment`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `See attached.`,
      `--${boundary}`,
      `Content-Type: text/csv; name="data.csv"`,
      `Content-Disposition: attachment; filename="data.csv"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      btoa(csv),
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    const message = buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw });
    await deliverEmail(message);

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    expect(listBody.data.messages).toHaveLength(1);
    expect(listBody.data.messages[0]!.hasAttachments).toBe(true);

    const detailRes = await SELF.fetch(
      `https://app.example.com/api/mailbox/messages/${listBody.data.messages[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id } }
    );
    const detailBody = (await detailRes.json()) as { data: MessageDetailDto };
    expect(detailBody.data.attachments).toHaveLength(1);
    expect(detailBody.data.attachments[0]!.filename).toBe("data.csv");

    const downloadRes = await SELF.fetch(
      `https://app.example.com/api/attachments/${detailBody.data.attachments[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id } }
    );
    expect(downloadRes.status).toBe(200);
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe(csv);
    expect(downloadRes.headers.get("Content-Disposition")).toContain("data.csv");
  });

  it("another mailbox cannot download the first mailbox's attachment", async () => {
    const mailboxA = await createAutoMailbox();
    const mailboxB = await createAutoMailbox();

    const boundary = "----=_Boundary";
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailboxA.address}`,
      `Subject: Private`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `Secret body.`,
      `--${boundary}`,
      `Content-Type: text/plain; name="secret.txt"`,
      `Content-Disposition: attachment; filename="secret.txt"`,
      ``,
      `top secret contents`,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailboxA.address, raw }));

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    const detailRes = await SELF.fetch(
      `https://app.example.com/api/mailbox/messages/${listBody.data.messages[0]!.id}`,
      { headers: { Authorization: `Bearer ${mailboxA.token}`, "X-Mailbox-Id": mailboxA.id } }
    );
    const detailBody = (await detailRes.json()) as { data: MessageDetailDto };
    const attachmentId = detailBody.data.attachments[0]!.id;

    // Mailbox B, authenticated as itself, tries to fetch mailbox A's attachment.
    const crossRes = await SELF.fetch(`https://app.example.com/api/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${mailboxB.token}`, "X-Mailbox-Id": mailboxB.id },
    });
    expect(crossRes.status).toBe(404);

    // And mailbox B cannot even see mailbox A's message via its own message list.
    const crossListRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailboxB.token}`, "X-Mailbox-Id": mailboxB.id },
    });
    const crossListBody = (await crossListRes.json()) as { data: { messages: MessageSummaryDto[] } };
    expect(crossListBody.data.messages).toHaveLength(0);
  });

  it("rejects delivery once a mailbox reaches its message-count cap", async () => {
    const mailbox = await createAutoMailbox();
    // MAX_MESSAGES_PER_MAILBOX from wrangler.toml test config; fetch it so
    // the test stays correct if the configured limit ever changes.
    const cap = Number(env.MAX_MESSAGES_PER_MAILBOX);

    for (let i = 0; i < cap; i++) {
      const raw = buildRawEmail({ to: mailbox.address, subject: `msg ${i}`, body: "filler" });
      await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));
    }

    const overflow = buildIncomingMessage({
      from: "sender@outside.example",
      to: mailbox.address,
      raw: buildRawEmail({ to: mailbox.address, subject: "one too many", body: "filler" }),
    });
    await deliverEmail(overflow);

    expect(overflow.rejectedWith).toMatch(/full/i);
  }, 20000);

  it("never lets an unhandled exception in the handler crash the email() entrypoint", async () => {
    const mailbox = await createAutoMailbox();
    // Corrupt raw stream: not valid UTF-8/MIME at all. The handler should
    // catch the parse failure internally and return normally.
    const message = buildIncomingMessage({
      from: "sender@outside.example",
      to: mailbox.address,
      raw: "not a valid mime message at all, no headers, no boundary",
    });

    const ctx = createExecutionContext();
    await expect(worker.email!(message, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});

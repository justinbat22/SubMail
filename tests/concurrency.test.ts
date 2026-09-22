import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";
import type { MailboxCreatedDto, MessageSummaryDto } from "../src/types/index.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

function buildIncomingMessage(opts: { from: string; to: string; raw: string }): ForwardableEmailMessage & {
  rejectedWith: string | null;
} {
  const rawBytes = new TextEncoder().encode(opts.raw);
  let rejectedWith: string | null = null;
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
    async forward() {},
    async reply() {},
    get rejectedWith() {
      return rejectedWith;
    },
  } as unknown as ForwardableEmailMessage & { rejectedWith: string | null };
}

function buildRawEmail(opts: { to: string; subject: string; messageId: string }): string {
  return [
    `From: sender@outside.example`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}@outside.example>`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Body for ${opts.subject}.`,
    ``,
  ].join("\r\n");
}

async function deliverEmail(message: ForwardableEmailMessage): Promise<void> {
  const ctx = createExecutionContext();
  await worker.email!(message, env, ctx);
  await waitOnExecutionContext(ctx);
}

async function createAutoMailbox(): Promise<MailboxCreatedDto> {
  const res = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
  const body = (await res.json()) as { data: MailboxCreatedDto };
  return body.data;
}

describe("Concurrent email delivery cannot exceed the mailbox message limit", () => {
  it("never stores more than the configured limit, even under truly concurrent delivery", async () => {
    const mailbox = await createAutoMailbox();
    const limit = 10;
    await env.DB.prepare("UPDATE mailbox_limits SET value = ? WHERE key = 'max_messages_per_mailbox'")
      .bind(limit)
      .run();

    // Fire more concurrent deliveries than the limit allows, each with a
    // distinct Message-ID (so this exercises the *limit* race, not the
    // idempotency path). Promise.all lets each delivery's internal awaits
    // (D1 reads/writes) genuinely interleave — this is the same interleaving
    // pattern that would let a naive "COUNT then INSERT" overshoot the cap.
    const attempts = 25;
    const messages = Array.from({ length: attempts }, (_, i) =>
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailbox.address,
        raw: buildRawEmail({ to: mailbox.address, subject: `concurrent-${i}`, messageId: `concurrent-${i}-${crypto.randomUUID()}` }),
      })
    );

    await Promise.all(messages.map((m) => deliverEmail(m)));

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    expect(countRow?.count).toBe(limit);

    // Every attempt beyond the limit must have been explicitly bounced
    // (setReject called), not silently dropped or left in an ambiguous state.
    const rejectedCount = messages.filter((m) => (m as unknown as { rejectedWith: string | null }).rejectedWith !== null).length;
    expect(rejectedCount).toBe(attempts - limit);
  }, 30000);

  it("respects the limit across multiple waves of concurrent delivery, not just one burst", async () => {
    const mailbox = await createAutoMailbox();
    const limit = 5;
    await env.DB.prepare("UPDATE mailbox_limits SET value = ? WHERE key = 'max_messages_per_mailbox'")
      .bind(limit)
      .run();

    // Wave 1: fill most of the way.
    const wave1 = Array.from({ length: 4 }, (_, i) =>
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailbox.address,
        raw: buildRawEmail({ to: mailbox.address, subject: `w1-${i}`, messageId: `w1-${i}-${crypto.randomUUID()}` }),
      })
    );
    await Promise.all(wave1.map((m) => deliverEmail(m)));

    // Wave 2: several more concurrent deliveries, only one of which should fit.
    const wave2 = Array.from({ length: 10 }, (_, i) =>
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailbox.address,
        raw: buildRawEmail({ to: mailbox.address, subject: `w2-${i}`, messageId: `w2-${i}-${crypto.randomUUID()}` }),
      })
    );
    await Promise.all(wave2.map((m) => deliverEmail(m)));

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    expect(countRow?.count).toBe(limit);
  }, 30000);

  it("does not let concurrent delivery to DIFFERENT mailboxes interfere with each other's limits", async () => {
    const mailboxA = await createAutoMailbox();
    const mailboxB = await createAutoMailbox();
    const limit = 5;
    await env.DB.prepare("UPDATE mailbox_limits SET value = ? WHERE key = 'max_messages_per_mailbox'")
      .bind(limit)
      .run();

    const forA = Array.from({ length: 8 }, (_, i) =>
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailboxA.address,
        raw: buildRawEmail({ to: mailboxA.address, subject: `a-${i}`, messageId: `a-${i}-${crypto.randomUUID()}` }),
      })
    );
    const forB = Array.from({ length: 3 }, (_, i) =>
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailboxB.address,
        raw: buildRawEmail({ to: mailboxB.address, subject: `b-${i}`, messageId: `b-${i}-${crypto.randomUUID()}` }),
      })
    );

    await Promise.all([...forA, ...forB].map((m) => deliverEmail(m)));

    const countA = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailboxA.id)
      .first<{ count: number }>();
    const countB = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailboxB.id)
      .first<{ count: number }>();

    expect(countA?.count).toBe(limit); // capped
    expect(countB?.count).toBe(3); // under the limit, all delivered
  }, 30000);
});

describe("Email delivery idempotency (retry safety)", () => {
  it("storing the same Message-ID twice for the same mailbox does not create a duplicate", async () => {
    const mailbox = await createAutoMailbox();
    const raw = buildRawEmail({ to: mailbox.address, subject: "retry-me", messageId: "fixed-id-123" });

    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));
    // Simulate Cloudflare retrying the exact same delivery.
    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));

    const listRes = await SELF.fetch("https://app.example.com/api/mailbox/messages", {
      headers: { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id },
    });
    const listBody = (await listRes.json()) as { data: { messages: MessageSummaryDto[] } };
    expect(listBody.data.messages).toHaveLength(1);
  });

  it("concurrent retries of the same delivery still result in exactly one stored message", async () => {
    const mailbox = await createAutoMailbox();
    const raw = buildRawEmail({ to: mailbox.address, subject: "concurrent-retry", messageId: "fixed-id-concurrent" });

    // Several "copies" of what Cloudflare might do if it retried a delivery
    // while a previous attempt's response was still in flight.
    const attempts = Array.from({ length: 6 }, () =>
      buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw })
    );
    await Promise.all(attempts.map((m) => deliverEmail(m)));

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    expect(countRow?.count).toBe(1);
  }, 15000);

  it("a duplicate delivery does not leave orphaned R2 objects behind", async () => {
    const mailbox = await createAutoMailbox();
    const boundary = "----=_Boundary";
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: dup-with-attachment`,
      `Message-ID: <dup-attach-1@outside.example>`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      `--${boundary}`,
      `Content-Type: text/plain; name="f.txt"`,
      `Content-Disposition: attachment; filename="f.txt"`,
      ``,
      `attachment contents`,
      `--${boundary}--`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));
    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));

    const attachmentCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM attachments").first<{ count: number }>();
    expect(attachmentCount?.count).toBe(1); // not 2 — the retry's R2 upload was cleaned up
  });

  it("different mailboxes receiving mail with the same Message-ID are NOT deduplicated against each other", async () => {
    const mailboxA = await createAutoMailbox();
    const mailboxB = await createAutoMailbox();

    await deliverEmail(
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailboxA.address,
        raw: buildRawEmail({ to: mailboxA.address, subject: "shared-id-a", messageId: "shared-across-mailboxes" }),
      })
    );
    await deliverEmail(
      buildIncomingMessage({
        from: "sender@outside.example",
        to: mailboxB.address,
        raw: buildRawEmail({ to: mailboxB.address, subject: "shared-id-b", messageId: "shared-across-mailboxes" }),
      })
    );

    const countA = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailboxA.id)
      .first<{ count: number }>();
    const countB = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailboxB.id)
      .first<{ count: number }>();
    expect(countA?.count).toBe(1);
    expect(countB?.count).toBe(1);
  });

  it("messages with no Message-ID header are never deduplicated against each other", async () => {
    const mailbox = await createAutoMailbox();
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: no message id`,
      `Content-Type: text/plain`,
      ``,
      `body without a message id`,
      ``,
    ].join("\r\n");

    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));
    await deliverEmail(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }));

    const countRow = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    // Both are stored — with no Message-ID, we cannot safely tell these
    // apart from two genuinely distinct emails, so we must not silently
    // drop either one.
    expect(countRow?.count).toBe(2);
  });
});

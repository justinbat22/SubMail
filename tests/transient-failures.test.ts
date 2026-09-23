import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import type { Env } from "../src/types/index.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";
import { createMailbox } from "../src/db/mailboxes.js";
import { hashToken, generateMailboxToken } from "../src/lib/token.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

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

async function createTestMailbox(localPart: string) {
  const tokenHash = await hashToken(generateMailboxToken());
  return createMailbox(env, {
    localPart,
    domain: "example.com",
    address: `${localPart}@example.com`,
    tokenHash,
    ttlHours: 48,
  });
}

describe("Transient vs permanent failure semantics in the email() entrypoint", () => {
  it("propagates (throws) when a B2 upload fails, so Cloudflare's retry can recover it", async () => {
    const mailbox = await createTestMailbox("transient-r2-test");

    const boundary = "----=_Boundary";
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: r2 outage test`,
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

    // Simulate a storage outage: same env, but the attachment storage put
    // always fails (the b2.ts test seam's ATTACHMENTS binding).
    const brokenEnv: Env = {
      ...env,
      ATTACHMENTS: {
        ...env.ATTACHMENTS,
        put: async () => {
          throw new Error("Simulated storage outage");
        },
      } as unknown as Env["ATTACHMENTS"],
    };

    const message = buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw });
    const ctx = createExecutionContext();

    await expect(worker.email!(message, brokenEnv, ctx)).rejects.toThrow();
    await waitOnExecutionContext(ctx);

    // No message row should exist — storage failed before any D1 write was attempted.
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE mailbox_id = ?")
      .bind(mailbox.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("propagates (throws) when the D1 write fails for a genuinely unexpected reason", async () => {
    const mailbox = await createTestMailbox("transient-d1-test");
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: d1 outage test`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      ``,
    ].join("\r\n");

    // Simulate a D1 outage: .batch() always fails with an unrelated error
    // (not a MAILBOX_FULL abort, not a UNIQUE constraint — a genuine failure).
    const brokenEnv: Env = {
      ...env,
      DB: {
        ...env.DB,
        prepare: env.DB.prepare.bind(env.DB),
        batch: async () => {
          throw new Error("D1_ERROR: simulated outage: SQLITE_ERROR");
        },
      } as unknown as Env["DB"],
    };

    const message = buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw });
    const ctx = createExecutionContext();

    await expect(worker.email!(message, brokenEnv, ctx)).rejects.toThrow();
    await waitOnExecutionContext(ctx);
  });

  it("still does NOT propagate for permanent conditions: malformed MIME is safely discarded, not thrown", async () => {
    const mailbox = await createTestMailbox("permanent-malformed-test");
    const message = buildIncomingMessage({
      from: "sender@outside.example",
      to: mailbox.address,
      raw: "not a valid mime message at all, no headers, no boundary, just garbage bytes \x00\x01\x02",
    });

    const ctx = createExecutionContext();
    await expect(worker.email!(message, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it("still does NOT propagate for permanent conditions: unknown recipient is silently discarded, not thrown", async () => {
    const message = buildIncomingMessage({
      from: "sender@outside.example",
      to: "nobody-here-at-all@example.com",
      raw: [
        `From: sender@outside.example`,
        `To: nobody-here-at-all@example.com`,
        `Subject: hi`,
        `Content-Type: text/plain`,
        ``,
        `hi`,
        ``,
      ].join("\r\n"),
    });

    const ctx = createExecutionContext();
    await expect(worker.email!(message, env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it("still does NOT propagate for permanent conditions: an already-processed duplicate is a no-op, not thrown", async () => {
    const mailbox = await createTestMailbox("permanent-duplicate-test");
    const raw = [
      `From: sender@outside.example`,
      `To: ${mailbox.address}`,
      `Subject: dup`,
      `Message-ID: <dup-no-throw@outside.example>`,
      `Content-Type: text/plain`,
      ``,
      `body`,
      ``,
    ].join("\r\n");

    const ctx1 = createExecutionContext();
    await worker.email!(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }), env, ctx1);
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    await expect(
      worker.email!(buildIncomingMessage({ from: "sender@outside.example", to: mailbox.address, raw }), env, ctx2)
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx2);
  });
});

import { describe, it, expect } from "vitest";
import { parseRawEmail, EmailParseError } from "../src/email/parser.js";

const BOUNDARY = "----=_TestBoundary123";

function buildRawMime(): Uint8Array {
  const attachmentContent = "id,name\n1,widget\n2,gadget\n";
  const attachmentB64 = btoa(attachmentContent);

  const raw = [
    `From: "Jane Sender" <jane@sender.example>`,
    `To: mytest123@example.com`,
    `Subject: Hello World`,
    `Message-ID: <abc123@sender.example>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    ``,
    `--${BOUNDARY}`,
    `Content-Type: multipart/alternative; boundary="${BOUNDARY}alt"`,
    ``,
    `--${BOUNDARY}alt`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hello, this is the plain text body.`,
    ``,
    `--${BOUNDARY}alt`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    `<p>Hello, this is the <b>HTML</b> body.</p><script>alert(1)</script>`,
    ``,
    `--${BOUNDARY}alt--`,
    `--${BOUNDARY}`,
    `Content-Type: text/csv; name="data.csv"`,
    `Content-Disposition: attachment; filename="data.csv"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    attachmentB64,
    ``,
    `--${BOUNDARY}--`,
    ``,
  ].join("\r\n");

  return new TextEncoder().encode(raw);
}

describe("parseRawEmail", () => {
  it("extracts sender, subject, and both body variants", async () => {
    const result = await parseRawEmail(buildRawMime());
    expect(result.senderName).toBe("Jane Sender");
    expect(result.senderAddress).toBe("jane@sender.example");
    expect(result.subject).toBe("Hello World");
    expect(result.messageId).toBe("<abc123@sender.example>");
    expect(result.textBody).toContain("Hello, this is the plain text body.");
    expect(result.htmlBody).toContain("Hello, this is the");
  });

  it("passes the HTML body through the defense-in-depth sanitizer", async () => {
    const result = await parseRawEmail(buildRawMime());
    expect(result.htmlBody).not.toContain("<script");
  });

  it("extracts attachments with correct filename, type, and content", async () => {
    const result = await parseRawEmail(buildRawMime());
    expect(result.attachments).toHaveLength(1);
    const attachment = result.attachments[0]!;
    expect(attachment.filename).toBe("data.csv");
    expect(attachment.sizeBytes).toBeGreaterThan(0);

    const decoded = new TextDecoder().decode(attachment.content);
    expect(decoded).toContain("widget");
    expect(decoded).toContain("gadget");
  });

  it("handles a plain-text-only message with no attachments", async () => {
    const raw = [
      `From: solo@sender.example`,
      `To: mytest123@example.com`,
      `Subject: Plain only`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      `Just plain text, nothing fancy.`,
      ``,
    ].join("\r\n");

    const result = await parseRawEmail(new TextEncoder().encode(raw));
    expect(result.textBody).toContain("Just plain text");
    expect(result.htmlBody).toBeNull();
    expect(result.attachments).toHaveLength(0);
  });

  it("throws EmailParseError rather than a raw exception on garbage input", async () => {
    // postal-mime is quite lenient, so to reliably exercise the error path
    // we pass something that cannot be interpreted as a MIME message at all.
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0xff, 0xff]);
    try {
      await parseRawEmail(garbage);
      // If postal-mime tolerates even this, that's fine too — the important
      // contract is "never throws something other than EmailParseError".
    } catch (err) {
      expect(err).toBeInstanceOf(EmailParseError);
    }
  });

  it("handles a missing/malformed From header without throwing", async () => {
    const raw = [`Subject: No sender`, `Content-Type: text/plain`, ``, `Body text.`, ``].join("\r\n");
    const result = await parseRawEmail(new TextEncoder().encode(raw));
    expect(result.senderAddress).toBeNull();
  });
});

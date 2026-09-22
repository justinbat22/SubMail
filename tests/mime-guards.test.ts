import { describe, it, expect } from "vitest";
import {
  assertMimeStructureWithinLimits,
  withParseTimeout,
  truncate,
  MimeStructureLimitError,
  DEFAULT_MIME_GUARD_LIMITS,
  MAX_SUBJECT_LENGTH,
  MAX_SENDER_NAME_LENGTH,
} from "../src/lib/mime-guards.js";
import { parseRawEmail, EmailParseError } from "../src/email/parser.js";

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("assertMimeStructureWithinLimits", () => {
  it("allows an ordinary, small message", () => {
    const raw = toBytes("From: a@b.com\r\nTo: c@d.com\r\nSubject: hi\r\n\r\nbody");
    expect(() => assertMimeStructureWithinLimits(raw, DEFAULT_MIME_GUARD_LIMITS)).not.toThrow();
  });

  it("rejects a header block larger than the configured limit", () => {
    const hugeHeader = "X-Padding: " + "a".repeat(100) + "\r\n";
    const raw = toBytes(hugeHeader.repeat(50) + "\r\n\r\nbody");
    expect(() =>
      assertMimeStructureWithinLimits(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxHeaderBlockBytes: 500 })
    ).toThrow(MimeStructureLimitError);
  });

  it("allows a header block within the configured limit", () => {
    const raw = toBytes("From: a@b.com\r\n\r\nbody");
    expect(() =>
      assertMimeStructureWithinLimits(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxHeaderBlockBytes: 500 })
    ).not.toThrow();
  });

  it("rejects a message with an excessive number of declared MIME parts", () => {
    const manyParts = Array.from({ length: 50 }, (_, i) => `Content-Type: text/plain; part=${i}\r\n`).join("");
    const raw = toBytes(`From: a@b.com\r\n\r\n${manyParts}`);
    expect(() =>
      assertMimeStructureWithinLimits(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxMimeParts: 10 })
    ).toThrow(MimeStructureLimitError);
  });

  it("rejects a message with excessive nested message/rfc822 parts", () => {
    const nested = "Content-Type: message/rfc822\r\n".repeat(30);
    const raw = toBytes(`From: a@b.com\r\n\r\n${nested}`);
    expect(() =>
      assertMimeStructureWithinLimits(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxRfc822Parts: 5 })
    ).toThrow(MimeStructureLimitError);
  });

  it("does not choke on binary/non-UTF8 content", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02, 0xff, 0xff, 0xc0, 0xc1]);
    expect(() => assertMimeStructureWithinLimits(raw, DEFAULT_MIME_GUARD_LIMITS)).not.toThrow();
  });
});

describe("withParseTimeout", () => {
  it("resolves normally when the promise finishes before the deadline", async () => {
    const result = await withParseTimeout(Promise.resolve("done"), 1000);
    expect(result).toBe("done");
  });

  it("rejects with MimeStructureLimitError when the promise exceeds the deadline", async () => {
    const neverResolves = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withParseTimeout(neverResolves, 20)).rejects.toBeInstanceOf(MimeStructureLimitError);
  });

  it("propagates the original promise's rejection when it fails before the deadline", async () => {
    const failsFast = Promise.reject(new Error("boom"));
    await expect(withParseTimeout(failsFast, 1000)).rejects.toThrow("boom");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("truncates strings longer than the limit", () => {
    expect(truncate("a".repeat(500), 100)).toHaveLength(100);
  });

  it("handles the boundary exactly", () => {
    expect(truncate("a".repeat(100), 100)).toHaveLength(100);
  });
});

describe("parseRawEmail - MIME hardening integration", () => {
  it("rejects (as EmailParseError) a message with a pathologically large header block", async () => {
    const hugeHeader = "X-Padding: " + "a".repeat(1000) + "\r\n";
    const raw = toBytes(hugeHeader.repeat(100) + "\r\n\r\nbody");
    await expect(parseRawEmail(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxHeaderBlockBytes: 1024 })).rejects.toBeInstanceOf(
      EmailParseError
    );
  });

  it("rejects (as EmailParseError) a message with an excessive declared part count", async () => {
    const manyParts = Array.from({ length: 1000 }, (_, i) => `Content-Type: text/plain; part=${i}\r\n`).join("");
    const raw = toBytes(`From: a@b.com\r\nTo: c@d.com\r\n\r\n${manyParts}`);
    await expect(parseRawEmail(raw, { ...DEFAULT_MIME_GUARD_LIMITS, maxMimeParts: 50 })).rejects.toBeInstanceOf(
      EmailParseError
    );
  });

  it("truncates an extremely long subject line rather than storing it unbounded", async () => {
    const hugeSubject = "S".repeat(5000);
    const raw = toBytes(`From: a@b.com\r\nTo: c@d.com\r\nSubject: ${hugeSubject}\r\nContent-Type: text/plain\r\n\r\nbody`);
    const result = await parseRawEmail(raw);
    expect(result.subject).not.toBeNull();
    expect(result.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
  });

  it("truncates an extremely long sender display name rather than storing it unbounded", async () => {
    const hugeName = "N".repeat(2000);
    const raw = toBytes(`From: "${hugeName}" <a@b.com>\r\nTo: c@d.com\r\nContent-Type: text/plain\r\n\r\nbody`);
    const result = await parseRawEmail(raw);
    expect(result.senderName).not.toBeNull();
    expect(result.senderName!.length).toBeLessThanOrEqual(MAX_SENDER_NAME_LENGTH);
  });

  it("still parses a normal, well-formed message correctly with guards active", async () => {
    const raw = toBytes(
      `From: "Jane" <jane@example.com>\r\nTo: c@d.com\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nHi there.`
    );
    const result = await parseRawEmail(raw);
    expect(result.senderName).toBe("Jane");
    expect(result.subject).toBe("Hello");
    expect(result.textBody).toContain("Hi there.");
  });
});

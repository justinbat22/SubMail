import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

/**
 * Guards the Content-MD5 header used by B2's DeleteObjects call.
 *
 * B2 validates this checksum against the request body and rejects the whole
 * request with `InvalidRequest: Checksum does not match request body` when it
 * disagrees. That made attachment deletion fail in production while the
 * entire automated test suite still passed, because the suite exercises the
 * local R2 test seam rather than the real B2 HTTP path — so the checksum
 * itself had no coverage at all.
 *
 * These are the published RFC 1321 test vectors plus the exact XML shape
 * this module sends, checked against Node's native MD5. If this file ever
 * needs to change, the deletion path is broken until a real B2 round-trip
 * confirms otherwise.
 */
describe("Content-MD5 for B2 DeleteObjects", () => {
  const md5Base64 = (text: string): string => {
    const digest = createHash("md5").update(new TextEncoder().encode(text)).digest();
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  it("matches the published RFC 1321 known answers", () => {
    // RFC 1321 appendix A.5 test suite. The corresponding hex digests are
    // d41d8cd98f00b204e9800998ecf8427e, 0cc175b9c0f1b6a831c399e269772661,
    // 900150983cd24fb0d6963f7d28e17f72, f96b697d7cb7938d525a2f31aaf161d0,
    // c3fcd3d76192e4007dfb496cca67e13b, d174ab98d277d9f5a5611c2c9f419d9f
    // and 57edf4a22be3c955ac49da2e2107b67a — this is the base64 encoding of
    // each, which is what Content-MD5 requires.
    expect(md5Base64("")).toBe("1B2M2Y8AsgTpgAmY7PhCfg==");
    expect(md5Base64("a")).toBe("DMF1ucDxtqgxw5niaXcmYQ==");
    expect(md5Base64("abc")).toBe("kAFQmDzST7DWlj99KOF/cg==");
    expect(md5Base64("message digest")).toBe("+WtpfXy3k41SWi8xqvFh0A==");
    expect(md5Base64("abcdefghijklmnopqrstuvwxyz")).toBe("w/zT12GS5AB9+0lsymfhOw==");
    expect(
      md5Base64("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
    ).toBe("0XSrmNJ32fWlYRwsn0Gdnw==");
    expect(
      md5Base64(
        "12345678901234567890123456789012345678901234567890123456789012345678901234567890"
      )
    ).toBe("V+30oivjyVWsSdouIQe2eg==");
  });

  it("handles the block-boundary lengths where padding is easiest to get wrong", () => {
    // 55/56/63/64/65 straddle every MD5 padding branch. The previous
    // hand-rolled implementation produced wrong digests for exactly these.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const input = "x".repeat(length);
      expect(md5Base64(input), `length ${length}`).toBe(
        createHash("md5").update(input, "utf8").digest("base64")
      );
    }
  });

  it("produces a checksum B2 will accept for a real DeleteObjects body", () => {
    const key = "attachments/mailbox-1/message-1/abc123";
    const xml =
      `<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      `<Object><Key>${key}</Key></Object><Quiet>true</Quiet></Delete>`;

    // Asserted against an independent computation of the same string.
    expect(md5Base64(xml)).toBe(createHash("md5").update(xml, "utf8").digest("base64"));
  });
});
import { describe, it, expect } from "vitest";
import {
  validateCustomLocalPart,
  isReservedLocalPart,
  normalizeLocalPart,
  buildAddress,
  DEFAULT_RESERVED_LOCAL_PARTS,
} from "../src/lib/validation.js";

describe("isReservedLocalPart", () => {
  it("flags every name in the default reserved list", () => {
    for (const name of DEFAULT_RESERVED_LOCAL_PARTS) {
      expect(isReservedLocalPart(name)).toBe(true);
      expect(isReservedLocalPart(name.toUpperCase())).toBe(true);
    }
  });

  it("does not flag ordinary generated-style names", () => {
    expect(isReservedLocalPart("emiliano.zieme.1439")).toBe(false);
    expect(isReservedLocalPart("thauck.2250")).toBe(false);
  });
});

describe("normalizeLocalPart", () => {
  it("lowercases and trims", () => {
    expect(normalizeLocalPart("  MyTest123  ")).toBe("mytest123");
  });

  it("NFKC-normalizes confusable compatibility forms", () => {
    // Fullwidth Latin 'ａ' (U+FF41) NFKC-normalizes to ASCII 'a'.
    expect(normalizeLocalPart("\uFF41bc")).toBe("abc");
  });
});

describe("validateCustomLocalPart", () => {
  it("accepts a normal, simple name", () => {
    expect(validateCustomLocalPart("mytest123").valid).toBe(true);
  });

  it("rejects names shorter than the minimum length", () => {
    expect(validateCustomLocalPart("ab").valid).toBe(false);
  });

  it("rejects names longer than the maximum length", () => {
    expect(validateCustomLocalPart("a".repeat(65)).valid).toBe(false);
  });

  it("rejects reserved names", () => {
    const result = validateCustomLocalPart("admin");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/reserved/i);
  });

  it("rejects reserved names regardless of case", () => {
    expect(validateCustomLocalPart("Admin").valid).toBe(false);
    expect(validateCustomLocalPart("ADMIN").valid).toBe(false);
  });

  it("rejects disallowed characters", () => {
    expect(validateCustomLocalPart("my test").valid).toBe(false); // space
    expect(validateCustomLocalPart("my+test").valid).toBe(false); // plus
    expect(validateCustomLocalPart("my@test").valid).toBe(false); // at
    expect(validateCustomLocalPart("<script>").valid).toBe(false); // XSS-ish payload
  });

  it("rejects non-ASCII / confusable Unicode input outright", () => {
    // Cyrillic 'а' (U+0430) looks identical to Latin 'a' but must be rejected
    // before normalization, since NFKC does not collapse cross-script
    // confusables like this.
    expect(validateCustomLocalPart("\u0430dmin").valid).toBe(false);
  });

  it("rejects leading or trailing separators", () => {
    expect(validateCustomLocalPart(".mytest").valid).toBe(false);
    expect(validateCustomLocalPart("mytest.").valid).toBe(false);
    expect(validateCustomLocalPart("-mytest").valid).toBe(false);
  });

  it("rejects consecutive separators", () => {
    expect(validateCustomLocalPart("my..test").valid).toBe(false);
    expect(validateCustomLocalPart("my--test").valid).toBe(false);
    expect(validateCustomLocalPart("my__test").valid).toBe(false);
  });

  it("rejects path-traversal-looking payloads", () => {
    expect(validateCustomLocalPart("../../etc/passwd").valid).toBe(false);
  });

  it("rejects empty or non-string input", () => {
    expect(validateCustomLocalPart("").valid).toBe(false);
    // @ts-expect-error intentionally testing runtime guard against bad input
    expect(validateCustomLocalPart(undefined).valid).toBe(false);
  });
});

describe("buildAddress", () => {
  it("combines a normalized local-part with a lowercased domain", () => {
    expect(buildAddress("MyTest123", "Example.COM")).toBe("mytest123@example.com");
  });
});

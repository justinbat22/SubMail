import { describe, it, expect } from "vitest";
import {
  generateUsername,
  generateUniqueUsername,
  generateFourDigitSuffix,
  choosePattern,
  secureRandomInt,
  DEFAULT_PATTERN_WEIGHTS,
  UsernameCollisionError,
  type UniquenessChecker,
} from "../src/lib/username-generator.js";
import { FIRST_NAMES } from "../data/first-names.js";
import { LAST_NAMES } from "../data/surnames.js";
import { DEFAULT_RESERVED_LOCAL_PARTS, LOCAL_PART_MAX_LENGTH } from "../src/lib/validation.js";

const VALID_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

describe("secureRandomInt", () => {
  it("never returns a value outside [0, max)", () => {
    for (let i = 0; i < 5000; i++) {
      const v = secureRandomInt(37);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(37);
    }
  });

  it("returns 0 for max=1", () => {
    expect(secureRandomInt(1)).toBe(0);
  });

  it("covers the full range given enough samples", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) seen.add(secureRandomInt(10));
    expect(seen.size).toBe(10);
  });
});

describe("generateFourDigitSuffix", () => {
  it("is always exactly four digits, zero-padded", () => {
    for (let i = 0; i < 2000; i++) {
      const suffix = generateFourDigitSuffix();
      expect(suffix).toMatch(/^\d{4}$/);
    }
  });

  it("produces values across the low and high end of the range (not just mid-range)", () => {
    const values = Array.from({ length: 3000 }, () => Number(generateFourDigitSuffix()));
    expect(values.some((v) => v < 100)).toBe(true);
    expect(values.some((v) => v > 9900)).toBe(true);
  });
});

describe("choosePattern", () => {
  it("only ever returns a key from the provided weights", () => {
    const allowedPatterns = new Set(Object.keys(DEFAULT_PATTERN_WEIGHTS));
    for (let i = 0; i < 2000; i++) {
      expect(allowedPatterns.has(choosePattern())).toBe(true);
    }
  });

  it("approximates the configured distribution over many draws", () => {
    const counts: Record<string, number> = {};
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const p = choosePattern();
      counts[p] = (counts[p] ?? 0) + 1;
    }
    for (const [pattern, weight] of Object.entries(DEFAULT_PATTERN_WEIGHTS)) {
      const observed = (counts[pattern] ?? 0) / N;
      // Generous tolerance (+/- 3 percentage points) to keep this test
      // reliable rather than flaky, per item 35's "do not depend on exact
      // random output" — this only needs to catch a badly broken formatter.
      expect(observed).toBeGreaterThan(weight - 0.03);
      expect(observed).toBeLessThan(weight + 0.03);
    }
  });

  it("respects fully custom weights, including a single forced pattern", () => {
    const forced = choosePattern({
      "first.last.####": 0,
      "last.first.####": 0,
      "first##.####": 1,
      "last.####": 0,
      "first.last####": 0,
    });
    expect(forced).toBe("first##.####");
  });
});

describe("generateUsername", () => {
  it("produces thousands of syntactically valid, bounded-length local-parts", () => {
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const username = generateUsername();
      expect(username.length).toBeLessThanOrEqual(LOCAL_PART_MAX_LENGTH);
      expect(username).toMatch(VALID_LOCAL_PART);
    }
  });

  it("only uses names drawn from the bundled datasets", () => {
    const firstSet = new Set(FIRST_NAMES);
    const lastSet = new Set(LAST_NAMES);

    for (let i = 0; i < 2000; i++) {
      const username = generateUsername();
      // Strip trailing numeric suffix(es) and rejoin remaining alpha tokens.
      const tokens = username.split(".");
      const alphaTokens = tokens
        .map((t) => t.replace(/\d+$/, ""))
        .filter((t) => t.length > 0);

      // Every alpha token must be a name from one of the two datasets.
      for (const token of alphaTokens) {
        expect(firstSet.has(token) || lastSet.has(token)).toBe(true);
      }
    }
  });

  it("never generates a reserved local-part", () => {
    const reserved = new Set(DEFAULT_RESERVED_LOCAL_PARTS);
    for (let i = 0; i < 5000; i++) {
      const username = generateUsername();
      expect(reserved.has(username)).toBe(false);
    }
  });

  it("produces all five documented pattern shapes across enough samples", () => {
    // Shapes are classified structurally rather than by re-deriving which
    // token was "first" vs "last" (both three-segment patterns produce an
    // identical alpha.alpha.#### shape, so they're intentionally counted
    // together — the point is to confirm every *distinct rendering shape*
    // the generator can produce actually occurs).
    const shapes = {
      threeSegmentAlphaAlphaNum: 0, // first.last.#### OR last.first.####
      firstNumDotNum: 0, // first##.####
      lastDotNum: 0, // last.####
      firstDotLastNum: 0, // first.last####
    };

    for (let i = 0; i < 8000; i++) {
      const u = generateUsername();
      const segments = u.split(".");

      if (segments.length === 3) {
        const [a, b, c] = segments as [string, string, string];
        if (/^[a-z]+$/.test(a) && /^[a-z]+$/.test(b) && /^\d{4}$/.test(c)) {
          shapes.threeSegmentAlphaAlphaNum++;
        }
        continue;
      }

      if (segments.length === 2) {
        const [a, b] = segments as [string, string];
        if (/^[a-z]+\d{2}$/.test(a) && /^\d{4}$/.test(b)) {
          shapes.firstNumDotNum++;
        } else if (/^[a-z]+$/.test(a) && /^\d{4}$/.test(b)) {
          shapes.lastDotNum++;
        } else if (/^[a-z]+$/.test(a) && /^[a-z]+\d{4}$/.test(b)) {
          shapes.firstDotLastNum++;
        }
      }
    }

    expect(shapes.threeSegmentAlphaAlphaNum).toBeGreaterThan(0);
    expect(shapes.firstNumDotNum).toBeGreaterThan(0);
    expect(shapes.lastDotNum).toBeGreaterThan(0);
    expect(shapes.firstDotLastNum).toBeGreaterThan(0);
  });

  it("respects maxLength by resampling rather than truncating", () => {
    // maxLength=12 is tight but comfortably achievable via several patterns
    // and the dataset's shorter names. This confirms short results are exact
    // valid renderings, never mid-string truncations of a longer candidate.
    for (let i = 0; i < 200; i++) {
      const u = generateUsername({ maxLength: 12 });
      expect(u.length).toBeLessThanOrEqual(12);
      expect(u).toMatch(VALID_LOCAL_PART);
    }
  }, 10000);

  it("throws rather than silently truncating when maxLength is unachievably small", () => {
    expect(() => generateUsername({ maxLength: 1 })).toThrow();
  });
});

describe("generateUniqueUsername", () => {
  it("returns immediately when the first candidate is available", async () => {
    const checker: UniquenessChecker = { isTaken: async () => false };
    const result = await generateUniqueUsername(checker);
    expect(result.attempts).toBe(1);
    expect(result.localPart.length).toBeGreaterThan(0);
  });

  it("retries on collision until an available name is found", async () => {
    let calls = 0;
    const checker: UniquenessChecker = {
      isTaken: async () => {
        calls++;
        return calls < 3; // first two calls "taken", third "available"
      },
    };
    const result = await generateUniqueUsername(checker);
    expect(result.attempts).toBe(3);
  });

  it("throws UsernameCollisionError after exhausting max attempts", async () => {
    const checker: UniquenessChecker = { isTaken: async () => true };
    await expect(generateUniqueUsername(checker, { maxAttempts: 4 })).rejects.toBeInstanceOf(
      UsernameCollisionError
    );
  });
});

describe("bundled name datasets", () => {
  it("contain several hundred unique first names and surnames", () => {
    expect(FIRST_NAMES.length).toBeGreaterThanOrEqual(300);
    expect(LAST_NAMES.length).toBeGreaterThanOrEqual(300);
    expect(new Set(FIRST_NAMES).size).toBe(FIRST_NAMES.length);
    expect(new Set(LAST_NAMES).size).toBe(LAST_NAMES.length);
  });

  it("contains only lowercase-safe entries with no leading/trailing whitespace", () => {
    for (const name of [...FIRST_NAMES, ...LAST_NAMES]) {
      expect(name).toBe(name.toLowerCase().trim());
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

import { FIRST_NAMES } from "../../data/first-names.js";
import { LAST_NAMES } from "../../data/surnames.js";
import type { UsernamePattern, UsernameGeneratorOptions } from "../types/index.js";
import { isReservedLocalPart } from "./validation.js";

/**
 * Default pattern distribution, per the product spec:
 *   40% first.last.####
 *   25% last.first.####
 *   15% first##.####
 *   10% last.####
 *   10% first.last####
 */
export const DEFAULT_PATTERN_WEIGHTS: Record<UsernamePattern, number> = {
  "first.last.####": 0.4,
  "last.first.####": 0.25,
  "first##.####": 0.15,
  "last.####": 0.1,
  "first.last####": 0.1,
};

const DEFAULT_MAX_LENGTH = 64; // RFC 5321 local-part limit

/**
 * Cryptographically-random unsigned integer in [0, maxExclusive).
 * Uses rejection sampling over crypto.getRandomValues to avoid modulo bias.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error("maxExclusive must be positive");
  if (maxExclusive === 1) return 0;

  const bytesNeeded = Math.ceil(Math.log2(maxExclusive) / 8) || 1;
  const maxValidRange = 256 ** bytesNeeded - (256 ** bytesNeeded % maxExclusive);

  const buf = new Uint8Array(bytesNeeded);
  while (true) {
    crypto.getRandomValues(buf);
    let value = 0;
    for (let i = 0; i < bytesNeeded; i++) {
      value = value * 256 + (buf[i] as number);
    }
    if (value < maxValidRange) {
      return value % maxExclusive;
    }
    // else: rejected sample, loop and try again (extremely rare)
  }
}

/** Pick a uniformly random element from a non-empty readonly array using secure randomness. */
function secureChoice<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("Cannot choose from an empty array");
  const idx = secureRandomInt(arr.length);
  return arr[idx] as T;
}

/** Generate a random four-digit numeric suffix, zero-padded, using secure randomness. */
export function generateFourDigitSuffix(): string {
  return String(secureRandomInt(10000)).padStart(4, "0");
}

/** Generate a random one-or-two-digit suffix used inline in patterns like first##. */
function generateTwoDigitInline(): string {
  return String(secureRandomInt(100)).padStart(2, "0");
}

/**
 * Select a pattern according to the configured weights using secure randomness.
 * Falls back gracefully if custom weights don't sum to exactly 1 by normalizing.
 */
export function choosePattern(
  weights: Record<UsernamePattern, number> = DEFAULT_PATTERN_WEIGHTS
): UsernamePattern {
  const entries = Object.entries(weights) as [UsernamePattern, number][];
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
  if (total <= 0) throw new Error("Pattern weights must sum to a positive number");

  // Draw a random point in [0, total) with reasonable resolution, then walk the
  // cumulative distribution. 1,000,000 buckets gives ample precision for weights
  // specified to a few decimal places without needing floating-point RNG.
  const resolution = 1_000_000;
  const r = (secureRandomInt(resolution) / resolution) * total;

  let cumulative = 0;
  for (const [pattern, weight] of entries) {
    cumulative += Math.max(0, weight);
    if (r < cumulative) return pattern;
  }
  // Floating-point edge case: return the last pattern.
  return entries[entries.length - 1]![0];
}

function renderPattern(pattern: UsernamePattern, first: string, last: string): string {
  switch (pattern) {
    case "first.last.####":
      return `${first}.${last}.${generateFourDigitSuffix()}`;
    case "last.first.####":
      return `${last}.${first}.${generateFourDigitSuffix()}`;
    case "first##.####":
      return `${first}${generateTwoDigitInline()}.${generateFourDigitSuffix()}`;
    case "last.####":
      return `${last}.${generateFourDigitSuffix()}`;
    case "first.last####":
      return `${first}.${last}${generateFourDigitSuffix()}`;
  }
}

/**
 * Generate a single Faker-style, human-looking username (email local-part),
 * entirely from the locally-bundled name datasets. Makes no network calls.
 *
 * Note: this function does not guarantee uniqueness by itself — callers that
 * need a unique mailbox address should use `generateUniqueUsername`, which
 * retries against a caller-supplied availability check.
 */
export function generateUsername(options: UsernameGeneratorOptions = {}): string {
  const weights = { ...DEFAULT_PATTERN_WEIGHTS, ...options.patternWeights };
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  // Bounded retry loop: extremely long name combinations could in theory
  // exceed maxLength; if so, resample rather than silently truncating (which
  // could produce confusing or colliding local-parts). 200 attempts keeps
  // this cheap (pure in-memory, no I/O) while giving even a tight maxLength
  // a realistic chance of hitting one of the dataset's shorter names.
  for (let attempt = 0; attempt < 200; attempt++) {
    const first = secureChoice(FIRST_NAMES);
    const last = secureChoice(LAST_NAMES);
    const pattern = choosePattern(weights);
    const candidate = renderPattern(pattern, first, last);

    if (candidate.length <= maxLength && !isReservedLocalPart(candidate)) {
      return candidate;
    }
  }

  // Practically unreachable given dataset lengths and maxLength=64, but fail
  // loudly rather than returning an invalid username.
  throw new Error("Failed to generate a valid username within length constraints");
}

/**
 * A minimal interface for checking whether a local-part is already taken.
 * Implemented by the D1-backed mailbox repository in production, and by an
 * in-memory Set in tests.
 */
export interface UniquenessChecker {
  isTaken(localPart: string): Promise<boolean>;
}

export interface GenerateUniqueUsernameResult {
  localPart: string;
  attempts: number;
}

/**
 * Generate a username and retry on collision against a caller-supplied
 * uniqueness checker. This is a *convenience* layer only — the database's
 * UNIQUE constraint on `address` remains the authoritative source of truth
 * (see migrations/0001_initial.sql and db/mailboxes.ts), so a race between
 * the check here and the eventual INSERT is expected to be resolved there,
 * not here.
 */
export async function generateUniqueUsername(
  checker: UniquenessChecker,
  options: UsernameGeneratorOptions & { maxAttempts?: number } = {}
): Promise<GenerateUniqueUsernameResult> {
  const maxAttempts = options.maxAttempts ?? 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const localPart = generateUsername(options);
    const taken = await checker.isTaken(localPart);
    if (!taken) {
      return { localPart, attempts: attempt };
    }
  }

  throw new UsernameCollisionError(
    `Could not generate a unique username after ${maxAttempts} attempts`
  );
}

export class UsernameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsernameCollisionError";
  }
}

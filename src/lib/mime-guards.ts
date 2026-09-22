/**
 * postal-mime (the MIME parser this app uses — see src/email/parser.ts)
 * exposes no configuration for structural safety limits: no max nesting
 * depth, no max part count, no max header size. This module supplies that
 * missing layer with our own pre-parse checks on the raw bytes, run BEFORE
 * postal-mime ever sees the input, so a pathological message is rejected
 * cheaply (a few regex scans over the raw bytes) rather than after paying
 * the cost of a full recursive parse.
 *
 * These are deliberately coarse, cheap heuristics — not a MIME parser of
 * our own — since the goal is bounding worst-case cost, not perfect
 * structural validation (postal-mime, and RFC 5322 parsing generally,
 * already handles "correctly reject malformed but small" cases fine; what
 * it doesn't protect against is "technically parseable but structurally
 * enormous relative to its byte size").
 */

export interface MimeGuardLimits {
  /** Reject if the raw message's header block (before the first blank line) exceeds this many bytes. */
  maxHeaderBlockBytes: number;
  /** Reject if there appear to be more than this many MIME part boundaries. */
  maxMimeParts: number;
  /** Reject if there appear to be more than this many nested message/rfc822 parts (a nested-email-bomb proxy). */
  maxRfc822Parts: number;
  /** Wall-clock budget for the parse call itself; a timeout is treated as a parse failure. */
  parseTimeoutMs: number;
}

export const DEFAULT_MIME_GUARD_LIMITS: MimeGuardLimits = {
  maxHeaderBlockBytes: 64 * 1024, // 64 KiB of headers is already generous
  maxMimeParts: 500,
  maxRfc822Parts: 20,
  parseTimeoutMs: 5000,
};

export class MimeStructureLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeStructureLimitError";
  }
}

/**
 * Cheap, pre-parse structural sanity checks on the raw message bytes.
 * Throws MimeStructureLimitError if the message looks pathological.
 */
export function assertMimeStructureWithinLimits(raw: Uint8Array, limits: MimeGuardLimits): void {
  // Decode defensively — this is only used for heuristic scanning, so a
  // best-effort UTF-8 decode (replacing invalid sequences) is fine even
  // for binary-ish content; we're just counting substrings, not
  // interpreting semantics.
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(raw);

  const headerBlockEnd = findHeaderBlockEnd(text);
  if (headerBlockEnd > limits.maxHeaderBlockBytes) {
    throw new MimeStructureLimitError(
      `Header block (${headerBlockEnd} bytes) exceeds the ${limits.maxHeaderBlockBytes}-byte limit.`
    );
  }

  const contentTypeCount = countOccurrences(text, /content-type\s*:/gi);
  if (contentTypeCount > limits.maxMimeParts) {
    throw new MimeStructureLimitError(
      `Message appears to declare ${contentTypeCount} MIME parts, exceeding the limit of ${limits.maxMimeParts}.`
    );
  }

  const rfc822Count = countOccurrences(text, /message\/rfc822/gi);
  if (rfc822Count > limits.maxRfc822Parts) {
    throw new MimeStructureLimitError(
      `Message appears to nest ${rfc822Count} message/rfc822 parts, exceeding the limit of ${limits.maxRfc822Parts}.`
    );
  }
}

/** Index of the end of the top-level header block (first blank line), or the whole text's length if none is found. */
function findHeaderBlockEnd(text: string): number {
  const crlfIndex = text.indexOf("\r\n\r\n");
  const lfIndex = text.indexOf("\n\n");
  if (crlfIndex === -1 && lfIndex === -1) return text.length;
  if (crlfIndex === -1) return lfIndex;
  if (lfIndex === -1) return crlfIndex;
  return Math.min(crlfIndex, lfIndex);
}

function countOccurrences(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/**
 * Race a promise against a deadline. If the deadline wins, throws
 * MimeStructureLimitError rather than leaving the original promise's
 * eventual rejection/resolution to surface later — the caller should treat
 * a timeout exactly like any other parse failure (safe discard, not a
 * crash, never silently retried forever).
 */
export async function withParseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MimeStructureLimitError(`MIME parsing exceeded the ${timeoutMs}ms time budget.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// Post-parse truncation
// ---------------------------------------------------------------------------

export const MAX_SUBJECT_LENGTH = 998; // RFC 5322 section 2.1.1 recommended max header line length
export const MAX_SENDER_NAME_LENGTH = 255;

/** Truncate a string to at most `maxLength` characters, or return it unchanged if already within bounds. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

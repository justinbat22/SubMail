/**
 * Reserved local-parts that must never be assignable, whether auto-generated
 * or chosen by a user. Kept as a plain configurable array (not hard-coded
 * throughout the app) so it can be extended without touching call sites.
 */
export const DEFAULT_RESERVED_LOCAL_PARTS: readonly string[] = [
  "admin", "administrator", "root", "system", "support", "security",
  "abuse", "postmaster", "hostmaster", "webmaster", "mailer-daemon",
  "noreply", "no-reply", "help", "contact", "info", "billing", "legal",
  "privacy", "test", "testing", "api", "www", "ftp", "smtp", "imap", "pop",
  // Additional common sensitive/likely-abused local-parts
  "sales", "marketing", "office", "sysadmin", "moderator", "mod",
  "owner", "staff", "team", "notifications", "notification", "alert",
  "alerts", "feedback", "compliance", "legalese", "dmca", "spam",
  "phishing", "ceo", "cfo", "cto", "hr", "payroll", "finance",
];

let reservedLocalParts: Set<string> = new Set(
  DEFAULT_RESERVED_LOCAL_PARTS.map((s) => s.toLowerCase())
);

/** Replace the reserved-name set at runtime (e.g. from configuration or D1). */
export function configureReservedLocalParts(list: readonly string[]): void {
  reservedLocalParts = new Set(list.map((s) => s.toLowerCase()));
}

export function isReservedLocalPart(localPart: string): boolean {
  return reservedLocalParts.has(normalizeLocalPart(localPart));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a candidate local-part for comparison and storage:
 * - lowercased
 * - Unicode NFKC-normalized (collapses many confusable/compatibility forms)
 * - trimmed
 */
export function normalizeLocalPart(localPart: string): string {
  return localPart.normalize("NFKC").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Syntax validation
// ---------------------------------------------------------------------------

export const LOCAL_PART_MIN_LENGTH = 3;
export const LOCAL_PART_MAX_LENGTH = 64; // RFC 5321 local-part limit

/**
 * Allowed characters for user-chosen local-parts: lowercase ASCII letters,
 * digits, dot, hyphen, underscore. Deliberately conservative — this is far
 * narrower than what RFC 5321 technically permits, which is the point: it
 * eliminates whole classes of confusable-Unicode, quoting, and escaping
 * issues rather than trying to enumerate them.
 */
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Disallow consecutive separators like ".." or "--" or "__", and leading/trailing separators. */
const CONSECUTIVE_SEPARATOR_PATTERN = /[._-]{2,}/;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a user-supplied (custom) local-part. Applies stricter checks than
 * generated usernames, since this is untrusted input.
 */
export function validateCustomLocalPart(rawInput: string): ValidationResult {
  if (typeof rawInput !== "string" || rawInput.length === 0) {
    return { valid: false, reason: "Local part is required." };
  }

  // Reject anything containing characters outside printable ASCII before
  // normalizing, to avoid confusable-Unicode local-parts (e.g. Cyrillic 'а'
  // that renders identically to Latin 'a').
  if (!/^[\x20-\x7e]*$/.test(rawInput)) {
    return { valid: false, reason: "Only ASCII letters, digits, dot, hyphen, and underscore are allowed." };
  }

  const normalized = normalizeLocalPart(rawInput);

  if (normalized.length < LOCAL_PART_MIN_LENGTH) {
    return { valid: false, reason: `Must be at least ${LOCAL_PART_MIN_LENGTH} characters.` };
  }
  if (normalized.length > LOCAL_PART_MAX_LENGTH) {
    return { valid: false, reason: `Must be at most ${LOCAL_PART_MAX_LENGTH} characters.` };
  }
  if (!LOCAL_PART_PATTERN.test(normalized)) {
    return {
      valid: false,
      reason: "Only lowercase letters, digits, dot, hyphen, and underscore are allowed, and it must start and end with a letter or digit.",
    };
  }
  if (CONSECUTIVE_SEPARATOR_PATTERN.test(normalized)) {
    return { valid: false, reason: "Cannot contain consecutive separators (.., --, __)." };
  }
  if (isReservedLocalPart(normalized)) {
    return { valid: false, reason: "This name is reserved." };
  }

  return { valid: true };
}

/**
 * Validate a generated local-part. Generated usernames come from a trusted,
 * closed dataset and pattern set, so this is a lighter sanity check used as
 * a defense-in-depth guard before it ever reaches the database — it should
 * never actually fail in practice.
 */
export function validateGeneratedLocalPart(localPart: string): ValidationResult {
  const normalized = normalizeLocalPart(localPart);

  if (normalized.length < 1 || normalized.length > LOCAL_PART_MAX_LENGTH) {
    return { valid: false, reason: "Generated local-part length out of bounds." };
  }
  if (!LOCAL_PART_PATTERN.test(normalized)) {
    return { valid: false, reason: "Generated local-part contains invalid characters." };
  }
  if (isReservedLocalPart(normalized)) {
    return { valid: false, reason: "Generated local-part collided with a reserved name." };
  }
  return { valid: true };
}

/** Build the full address for a local-part + domain, after normalizing the local-part. */
export function buildAddress(localPart: string, domain: string): string {
  return `${normalizeLocalPart(localPart)}@${domain.toLowerCase().trim()}`;
}

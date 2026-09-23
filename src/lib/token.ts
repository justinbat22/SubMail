/**
 * Mailbox access tokens.
 *
 * The email address is NOT a credential — anyone who sees an address must
 * not be able to read that mailbox's contents. Every mailbox therefore gets
 * a separate, high-entropy access token:
 *   - generated with crypto.getRandomValues (never Math.random)
 *   - only ever transmitted once, at mailbox-creation time
 *   - stored in D1 as a SHA-256 hash, never in plaintext
 *   - compared using a constant-time comparison to avoid timing side-channels
 */

const TOKEN_BYTE_LENGTH = 32; // 256 bits of entropy

/** Generate a new, cryptographically secure mailbox access token, base64url-encoded. */
export function generateMailboxToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** SHA-256 hash of a token, hex-encoded, for storage in D1's token_hash column. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Verify a presented token against a stored hash. Recomputes the hash and
 * compares digests in constant time to avoid leaking information via
 * response-time side channels.
 */
export async function verifyToken(presentedToken: string, storedHash: string): Promise<boolean> {
  if (!presentedToken || !storedHash) return false;
  const presentedHash = await hashToken(presentedToken);
  return constantTimeEqual(presentedHash, storedHash);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison of equal (dummy) length to avoid an early
    // length-based timing signal, then return false.
    let dummy = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dummy |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
    }
    void dummy; // computed only to keep this branch's timing comparable to the equal-length path
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random opaque mailbox ID (not the email address itself, and not
 * derived from it). Used as the D1 primary key and in object-storage (B2)
 * key prefixes.
 */
export function generateMailboxId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** Generate a random opaque ID for messages, attachments, and storage key segments. */
export function generateId(): string {
  return generateMailboxId();
}

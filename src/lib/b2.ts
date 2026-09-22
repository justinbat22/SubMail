/**
 * Attachment object storage — Backblaze B2 (S3-Compatible API), with a
 * local-R2 test seam.
 *
 * Replaces the previous native R2 binding (`env.ATTACHMENTS`) as the
 * production storage backend with B2's S3-Compatible API, which Backblaze
 * documents at https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api:
 *
 *  - Endpoint format: `https://s3.<region>.backblazeb2.com` (HTTPS only),
 *    with the bucket specified in the path ("path-style" addressing), which
 *    B2 explicitly supports for direct HTTP calls.
 *  - Auth: AWS Signature V4 only. The B2 *application key* is the secret
 *    access key and the *keyID* is the access key ID. The master account
 *    key is NOT supported — a dedicated app key must be created (with at
 *    least the readFiles/writeFiles/deleteFiles capabilities).
 *  - Only three operations are needed (the exact set the old R2 binding
 *    served): Put Object, Get Object, and batch Delete Objects (POST
 *    `?delete`, up to 1000 keys per call — B2 follows the S3 DeleteObjects
 *    contract, including its REQUIRED Content-MD5 request header, which
 *    Web Crypto cannot produce since it has no MD5; a compact RFC 1321
 *    implementation lives at the bottom of this file).
 *
 * Requests are signed with `aws4fetch`, a ~2.5 kB gzipped signer built for
 * Workers' fetch + SubtleCrypto, with built-in exponential-backoff retries
 * for transient failures (mirroring the durability the native R2 binding
 * used to provide for free).
 *
 * Failure semantics are kept identical to the R2 version:
 *  - A missing object on read is a `null` return value, not an error (the
 *    attachment route maps it to ATTACHMENT_NOT_FOUND).
 *  - Deleting a key that doesn't exist is a successful no-op (S3/B2
 *    DeleteObjects treat absent keys as deleted), so cleanup remains
 *    idempotent.
 *  - Anything else (auth failure, network failure, 5xx after retries) is
 *    thrown so callers' existing transient-vs-permanent handling (propagate
 *    out of email() for retry vs. handle inline) keeps working unchanged.
 *
 * TEST SEAM: if the environment provides an R2-compatible `ATTACHMENTS`
 * binding (as the vitest-pool-workers suite does via a local Miniflare R2
 * bucket), it is used instead of B2. This keeps the test suite offline and
 * deterministic while exercising the exact same code paths — including
 * fault injection (`tests/transient-failures.test.ts` stubs
 * `ATTACHMENTS.put` to throw). In production the binding is absent and the
 * B2 path is always taken.
 *
 * Note: the D1 column holding object keys is still named `r2_key` (a purely
 * historical name kept to avoid a schema migration — it stores an opaque,
 * storage-agnostic key, and keys are randomly generated, never derived from
 * filenames or addresses).
 */

import { AwsClient } from "aws4fetch";
import type { Env } from "../types/index.js";

/** S3 DeleteObjects accepts at most 1000 keys per request (B2 follows this). */
const STORAGE_DELETE_BATCH_SIZE = 1000;

/** B2's Delete Objects requires Content-MD5 (an AWS S3 contract it follows). */
const S3_XML_NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";

/** The three operations the attachment pipeline needs from object storage. */
interface AttachmentStorage {
  put(key: string, content: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null>;
  deleteMany(keys: string[]): Promise<void>;
}

/**
 * Resolve the storage backend: the R2-compatible `ATTACHMENTS` binding if
 * the environment provides one (test/local), otherwise B2's S3-Compatible
 * API (production).
 */
function resolveAttachmentStorage(env: Env): AttachmentStorage {
  if (env.ATTACHMENTS) {
    return r2BindingStorage(env.ATTACHMENTS);
  }
  return b2S3Storage(env);
}

// ---------------------------------------------------------------------------
// R2-compatible adapter (test/local seam only)
// ---------------------------------------------------------------------------

function r2BindingStorage(bucket: NonNullable<Env["ATTACHMENTS"]>): AttachmentStorage {
  return {
    async put(key, content, contentType) {
      await bucket.put(key, content, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? null,
      };
    },
    async deleteMany(keys) {
      if (keys.length > 0) {
        // R2 supports deleting up to 1000 keys per call, same as B2's
        // DeleteObjects; the caller already chunks at that size.
        await bucket.delete(keys);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Backblaze B2 adapter (production backend)
// ---------------------------------------------------------------------------

function b2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    // B2's S3-Compatible API only accepts v4 signatures; the service string
    // and region must be pinned because B2 endpoints don't follow the AWS
    // `s3.<region>.amazonaws.com` hostname convention aws4fetch parses from.
    service: "s3",
    region: env.B2_REGION,
  });
}

function b2ObjectUrl(env: Env, key: string): string {
  // Path-style: https://s3.<region>.backblazeb2.com/<bucket>/<object-key>
  return `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}/${encodeObjectKeyPath(key)}`;
}

/** Percent-encode each key segment (except `/` separators) for a URL path. */
function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function b2S3Storage(env: Env): AttachmentStorage {
  return {
    async put(key, content, contentType) {
      const client = b2Client(env);
      const response = await client.fetch(b2ObjectUrl(env, key), {
        method: "PUT",
        headers: { "Content-Type": contentType ?? "application/octet-stream" },
        body: content,
      });
      if (!response.ok) {
        throw new Error(`B2 PutObject failed for key ${key}: HTTP ${response.status}`);
      }
    },

    async get(key) {
      const client = b2Client(env);
      const response = await client.fetch(b2ObjectUrl(env, key), { method: "GET" });

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`B2 GetObject failed for key ${key}: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error(`B2 GetObject returned no body for key ${key}`);
      }
      return { body: response.body, contentType: response.headers.get("content-type") };
    },

    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH_SIZE) {
        await b2DeleteObjectsChunk(env, keys.slice(i, i + STORAGE_DELETE_BATCH_SIZE));
      }
    },
  };
}

/**
 * Batch delete via B2's S3 DeleteObjects call. Deleting a nonexistent key
 * is a success (S3 semantics), so cleanup is idempotent.
 */
async function b2DeleteObjectsChunk(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  const body = buildDeleteObjectsXml(keys);
  const client = b2Client(env);
  // Path-style bucket URL with the `?delete` subresource (DeleteObjects).
  const response = await client.fetch(
    `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}?delete`,
    {
      method: "POST",
      headers: { "Content-MD5": md5Base64(body) },
      body,
    }
  );

  if (!response.ok) {
    throw new Error(`B2 DeleteObjects failed for ${keys.length} keys: HTTP ${response.status}`);
  }

  // A 200 response can still contain per-key <Error> elements (e.g. an
  // AccessDenied for one key). Quiet mode means any <Error> in the body is
  // a real per-key failure — surface it rather than pretending all keys
  // were deleted.
  const responseText = await response.text();
  if (responseText.includes("<Error>")) {
    throw new Error(`B2 DeleteObjects reported per-key errors for ${keys.length} keys`);
  }
}

function buildDeleteObjectsXml(keys: string[]): string {
  const objectElements = keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("");
  // Quiet mode: the response only lists keys that FAILED to delete.
  return (
    `<Delete xmlns="${S3_XML_NAMESPACE}">` + objectElements + "<Quiet>true</Quiet></Delete>"
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Public storage-agnostic API — the only surface the rest of the app uses.
// ---------------------------------------------------------------------------

/**
 * Store an object (attachment bytes). Equivalent to the old
 * `env.ATTACHMENTS.put(key, content, { httpMetadata: { contentType } })`.
 * Throws on failure — callers treat that as a transient storage error.
 */
export async function putStoredObject(
  env: Env,
  key: string,
  content: Uint8Array,
  contentType: string | null
): Promise<void> {
  await resolveAttachmentStorage(env).put(key, content, contentType);
}

/**
 * Fetch an object's streaming body, or `null` if it does not exist (the R2
 * binding's `get()` returned null for missing keys; B2 answers S3-style
 * `NoSuchKey`/404, mapped here to the same outcome). Any other non-OK
 * response throws so unexpected auth/outage conditions stay surfaced as
 * transient storage errors.
 */
export async function getStoredObject(
  env: Env,
  key: string
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  return resolveAttachmentStorage(env).get(key);
}

/**
 * Delete any number of keys (chunked at the 1000-keys-per-call limit both
 * R2's batch delete and B2's DeleteObjects accept). Deleting a key that
 * doesn't exist is a no-op, so cleanup is idempotent.
 */
export async function deleteStoredObjects(env: Env, keys: string[]): Promise<void> {
  await resolveAttachmentStorage(env).deleteMany(keys);
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321) — needed solely for the Content-MD5 header on the B2 batch
// Delete Objects call, which the S3/B2 contract requires. Web Crypto offers
// no MD5, so this is a compact, allocation-light implementation over bytes.
// Only ever applied to a small, self-generated XML document — never to
// untrusted input or large payloads.
// ---------------------------------------------------------------------------

const MD5_SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(|sin(i + 1)| * 2^32) — RFC 1321's constant table.
const MD5_CONSTANTS = (() => {
  const constants = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return constants;
})();

function md5Base64(text: string): string {
  const digest = md5Digest(new TextEncoder().encode(text));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function md5Digest(input: Uint8Array): Uint8Array {
  // Padding: original bytes + 0x80 + zeros (until length ≡ 56 mod 64) + 8-byte
  // little-endian bit length.
  const padZeros = ((55 - (input.length % 64)) + 64) % 64;
  const totalLength = input.length + 1 + padZeros + 8;
  const padded = new Uint8Array(totalLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  for (let i = 0; i < 8; i++) {
    padded[totalLength - 8 + i] = (bitLength / 2 ** (8 * i)) & 0xff;
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let chunkStart = 0; chunkStart < totalLength; chunkStart += 64) {
    for (let j = 0; j < 16; j++) {
      const offset = chunkStart + j * 4;
      words[j] =
        padded[offset]! |
        (padded[offset + 1]! << 8) |
        (padded[offset + 2]! << 16) |
        (padded[offset + 3]! << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const sum = (f + a + MD5_CONSTANTS[i]! + words[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << MD5_SHIFT_AMOUNTS[i]!) | (sum >>> (32 - MD5_SHIFT_AMOUNTS[i]!)))) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  writeUint32Le(digest, 0, a0);
  writeUint32Le(digest, 4, b0);
  writeUint32Le(digest, 8, c0);
  writeUint32Le(digest, 12, d0);
  return digest;
}

function writeUint32Le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

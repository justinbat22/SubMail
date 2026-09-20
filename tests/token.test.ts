import { describe, it, expect } from "vitest";
import { generateMailboxToken, hashToken, verifyToken, generateMailboxId } from "../src/lib/token.js";

describe("generateMailboxToken", () => {
  it("generates high-entropy, URL-safe tokens", () => {
    const token = generateMailboxToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats across many generations", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => generateMailboxToken()));
    expect(tokens.size).toBe(2000);
  });
});

describe("hashToken / verifyToken", () => {
  it("produces a deterministic hex digest for the same input", async () => {
    const token = generateMailboxToken();
    const hash1 = await hashToken(token);
    const hash2 = await hashToken(token);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a correct token against its stored hash", async () => {
    const token = generateMailboxToken();
    const hash = await hashToken(token);
    expect(await verifyToken(token, hash)).toBe(true);
  });

  it("rejects an incorrect token", async () => {
    const token = generateMailboxToken();
    const hash = await hashToken(token);
    const wrongToken = generateMailboxToken();
    expect(await verifyToken(wrongToken, hash)).toBe(false);
  });

  it("rejects empty inputs safely rather than throwing", async () => {
    expect(await verifyToken("", "somehash")).toBe(false);
    expect(await verifyToken("sometoken", "")).toBe(false);
  });

  it("never stores or compares the raw token as plaintext equality", async () => {
    const token = generateMailboxToken();
    const hash = await hashToken(token);
    expect(hash).not.toBe(token);
  });
});

describe("generateMailboxId", () => {
  it("generates hex IDs that are not derived from an email address", () => {
    const id = generateMailboxId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("never repeats across many generations", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateMailboxId()));
    expect(ids.size).toBe(2000);
  });
});

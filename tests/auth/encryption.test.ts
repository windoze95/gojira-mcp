import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt } from "../../src/auth/encryption.js";

describe("AES-256-GCM encryption", () => {
  const key = randomBytes(32);

  it("round-trips arbitrary strings", () => {
    const plaintext = "the quick brown fox jumps over the lazy dog";
    const blob = encrypt(plaintext, key);
    expect(blob).not.toContain(plaintext);
    expect(decrypt(blob, key)).toBe(plaintext);
  });

  it("uses a unique IV per encryption (no nonce reuse)", () => {
    const a = encrypt("payload", key);
    const b = encrypt("payload", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("payload");
    expect(decrypt(b, key)).toBe("payload");
  });

  it("rejects tampered ciphertext", () => {
    const blob = encrypt("payload", key);
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a bit in the ciphertext
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("rejects ciphertext under a different key", () => {
    const blob = encrypt("payload", key);
    const otherKey = randomBytes(32);
    expect(() => decrypt(blob, otherKey)).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    const shortKey = randomBytes(16);
    expect(() => encrypt("x", shortKey)).toThrow();
    expect(() => decrypt("AAAAAAAAAAAAAAAAAAAA", shortKey)).toThrow();
  });
});

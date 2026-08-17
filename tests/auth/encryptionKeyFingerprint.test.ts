import { afterEach, describe, expect, it } from "vitest";
import {
  assertEncryptionKeyFingerprint,
  TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY,
} from "../../src/auth/encryptionKeyFingerprint.js";
import { encrypt } from "../../src/auth/encryption.js";
import { makeRedis } from "../helpers/redis.js";

const clients: ReturnType<typeof makeRedis>[] = [];

function redisForTest(): ReturnType<typeof makeRedis> {
  const redis = makeRedis();
  clients.push(redis);
  return redis;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((redis) => redis.quit()));
});

describe("TOKEN_ENCRYPTION_KEY Redis fingerprint", () => {
  it("atomically initializes a non-secret permanent marker", async () => {
    const redis = redisForTest();
    const key = Buffer.alloc(32, 7);

    await expect(assertEncryptionKeyFingerprint(redis, key)).resolves.toBe("initialized");

    const marker = await redis.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY);
    expect(marker).toMatch(/^[a-f0-9]{64}$/);
    expect(marker).not.toBe(key.toString("hex"));
    expect(marker).not.toContain(key.toString("base64"));
    expect(await redis.ttl(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)).toBe(-1);
  });

  it("accepts the same key from another shared-Redis instance", async () => {
    const redisA = redisForTest();
    const redisB = redisForTest();
    const key = Buffer.alloc(32, 9);

    await expect(assertEncryptionKeyFingerprint(redisA, key)).resolves.toBe("initialized");
    await expect(assertEncryptionKeyFingerprint(redisB, key)).resolves.toBe("matched");
  });

  it("claims a pre-marker namespace only after decrypting an existing credential", async () => {
    const redis = redisForTest();
    const key = Buffer.alloc(32, 5);
    await redis.set("token:legacy-account", encrypt('{"access_token":"legacy"}', key));

    await expect(assertEncryptionKeyFingerprint(redis, key)).resolves.toBe("initialized");
    expect(await redis.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("does not let a wrong key claim a populated pre-marker namespace", async () => {
    const redis = redisForTest();
    const correctKey = Buffer.alloc(32, 6);
    await redis.set(
      "apitoken:legacy-account",
      encrypt('{"token":"legacy"}', correctKey),
    );

    await expect(
      assertEncryptionKeyFingerprint(redis, Buffer.alloc(32, 8)),
    ).rejects.toThrow(/cannot decrypt credentials already stored/);
    expect(await redis.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)).toBeNull();
  });

  it("rejects a mixed pre-marker namespace even when another blob decrypts", async () => {
    const redis = redisForTest();
    const key = Buffer.alloc(32, 10);
    await redis.set("token:valid-account", encrypt('{"access_token":"valid"}', key));
    await redis.set(
      "apitoken:wrong-key-account",
      encrypt('{"token":"wrong-key"}', Buffer.alloc(32, 11)),
    );

    await expect(assertEncryptionKeyFingerprint(redis, key)).rejects.toThrow(
      /cannot decrypt credentials already stored/,
    );
    expect(await redis.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)).toBeNull();
  });

  it("rejects a mismatched fleet key without replacing the original marker", async () => {
    const redisA = redisForTest();
    const redisB = redisForTest();
    const expectedKey = Buffer.alloc(32, 1);
    const mismatchedKey = Buffer.alloc(32, 2);

    await assertEncryptionKeyFingerprint(redisA, expectedKey);
    const originalMarker = await redisA.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY);

    await expect(assertEncryptionKeyFingerprint(redisB, mismatchedKey)).rejects.toThrow(
      /does not match.*refusing to start/,
    );
    expect(await redisA.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)).toBe(originalMarker);
  });

  it("allows only one of two different first-start keys to claim an empty namespace", async () => {
    const redisA = redisForTest();
    const redisB = redisForTest();

    const outcomes = await Promise.allSettled([
      assertEncryptionKeyFingerprint(redisA, Buffer.alloc(32, 3)),
      assertEncryptionKeyFingerprint(redisB, Buffer.alloc(32, 4)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});

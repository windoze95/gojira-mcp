import { createHmac } from "node:crypto";
import type { RedisType } from "../redis/client.js";
import { decrypt } from "./encryption.js";

/**
 * Permanent marker for the encryption key claimed by this Redis namespace.
 * The HMAC is a one-way fingerprint; the encryption key itself never leaves
 * process memory.
 */
export const TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY =
  "token_encryption_key_fingerprint:v1";

const FINGERPRINT_CONTEXT = "gojira-mcp:TOKEN_ENCRYPTION_KEY:v1";

const CLAIM_FINGERPRINT_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1])
  return 'initialized'
end
if current == ARGV[1] then
  return 'matched'
end
return 'mismatch'
`;

export type EncryptionKeyFingerprintState = "initialized" | "matched";

/**
 * Atomically claim or verify the TOKEN_ENCRYPTION_KEY used by a shared Redis
 * namespace. A mismatch is fatal: serving with a different key would make
 * existing OAuth and API-token credentials unreadable.
 */
export async function assertEncryptionKeyFingerprint(
  redis: RedisType,
  encryptionKey: Buffer,
): Promise<EncryptionKeyFingerprintState> {
  const fingerprint = createHmac("sha256", encryptionKey)
    .update(FINGERPRINT_CONTEXT)
    .digest("hex");

  // Upgrade safety for Redis namespaces created before the fingerprint marker
  // existed: the first claimant must prove it can decrypt existing credential
  // ciphertext. Without this check, the first misconfigured container after an
  // upgrade could permanently claim the namespace with the wrong key.
  if ((await redis.get(TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY)) === null) {
    await assertLegacyCredentialReadable(redis, encryptionKey);
  }

  const state = await redis.eval(
    CLAIM_FINGERPRINT_SCRIPT,
    1,
    TOKEN_ENCRYPTION_KEY_FINGERPRINT_REDIS_KEY,
    fingerprint,
  );

  if (state === "initialized" || state === "matched") return state;
  if (state === "mismatch") {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY does not match the key claimed by this Redis namespace; refusing to start",
    );
  }
  throw new Error("Could not verify TOKEN_ENCRYPTION_KEY against Redis; refusing to start");
}

async function assertLegacyCredentialReadable(
  redis: RedisType,
  encryptionKey: Buffer,
): Promise<void> {
  // Scan the full credential set. Accepting after the first success would make
  // migration depend on Redis SCAN order when one legacy blob is corrupt or a
  // past deployment used inconsistent keys.
  for (const pattern of ["token:*", "apitoken:*"]) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = nextCursor;
      for (const key of keys) {
        const blob = await redis.get(key);
        if (blob === null) continue;
        try {
          decrypt(blob, encryptionKey);
        } catch {
          throw new Error(
            "TOKEN_ENCRYPTION_KEY cannot decrypt credentials already stored in this Redis namespace; fingerprint was not initialized and startup is refused",
          );
        }
      }
    } while (cursor !== "0");
  }
}

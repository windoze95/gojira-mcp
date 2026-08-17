import type { RedisType } from "../redis/client.js";
import { decrypt, encrypt } from "./encryption.js";
import { logger } from "../utils/logger.js";
import { ToolError } from "../middleware/errorHandler.js";

export interface StoredToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // unix ms
  account_id: string;
  name: string;
  email: string | null;
  accessible_cloud_ids: string[];
  primary_cloud_id: string | null;
}

export const STORED_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d sliding

const CAS_PUT_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`;

const CAS_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type CredentialKind = "oauth" | "api_token";

/**
 * The encrypted entry exists but cannot be trusted. Keep it intact for
 * operator recovery/forensics and surface only a stable, non-secret error.
 */
export class CredentialStoreUnreadableError extends ToolError {
  constructor(kind: CredentialKind) {
    super(
      "UNEXPECTED_ERROR",
      "A stored credential could not be read safely; operator intervention is required.",
      { reason: "CREDENTIAL_STORE_UNREADABLE", credential: kind },
    );
    this.name = "CredentialStoreUnreadableError";
  }
}

/**
 * `version` is the exact encrypted Redis value used as the compare-and-swap
 * guard. It must never be logged or returned to callers.
 */
export interface StoredTokenSnapshot {
  token: StoredToken;
  version: string;
}

export class TokenStore {
  constructor(
    private readonly redis: RedisType,
    private readonly key: Buffer,
  ) {}

  private k(accountId: string): string {
    return `token:${accountId}`;
  }

  async get(accountId: string): Promise<StoredToken | null> {
    return (await this.getSnapshot(accountId))?.token ?? null;
  }

  async getSnapshot(accountId: string): Promise<StoredTokenSnapshot | null> {
    const blob = await this.redis.get(this.k(accountId));
    if (!blob) return null;
    try {
      const json = decrypt(blob, this.key);
      const token = JSON.parse(json) as unknown;
      if (!isStoredToken(token)) throw new Error("stored OAuth credential has an invalid shape");
      return { token, version: blob };
    } catch {
      logger.warn(
        { accountId, credential: "oauth", reason: "decode_failed" },
        "Stored credential could not be read; preserving encrypted entry",
      );
      throw new CredentialStoreUnreadableError("oauth");
    }
  }

  async put(token: StoredToken): Promise<void> {
    const blob = encrypt(JSON.stringify(token), this.key);
    await this.redis.set(this.k(token.account_id), blob, "EX", STORED_TOKEN_TTL_SECONDS);
  }

  /** Atomically replace the entry only if it is still the snapshot we read. */
  async putIfUnchanged(token: StoredToken, expectedVersion: string): Promise<boolean> {
    const blob = encrypt(JSON.stringify(token), this.key);
    const result = await this.redis.eval(
      CAS_PUT_SCRIPT,
      1,
      this.k(token.account_id),
      expectedVersion,
      blob,
      STORED_TOKEN_TTL_SECONDS.toString(),
    );
    return Number(result) === 1;
  }

  async delete(accountId: string): Promise<void> {
    await this.redis.del(this.k(accountId));
  }

  /** Atomically delete the entry only if it is still the snapshot we read. */
  async deleteIfUnchanged(accountId: string, expectedVersion: string): Promise<boolean> {
    const result = await this.redis.eval(
      CAS_DELETE_SCRIPT,
      1,
      this.k(accountId),
      expectedVersion,
    );
    return Number(result) === 1;
  }
}

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Partial<StoredToken>;
  return (
    typeof token.access_token === "string" &&
    (typeof token.refresh_token === "string" || token.refresh_token === null) &&
    typeof token.expires_at === "number" &&
    Number.isFinite(token.expires_at) &&
    typeof token.account_id === "string" &&
    typeof token.name === "string" &&
    (typeof token.email === "string" || token.email === null) &&
    Array.isArray(token.accessible_cloud_ids) &&
    token.accessible_cloud_ids.every((id) => typeof id === "string") &&
    (typeof token.primary_cloud_id === "string" || token.primary_cloud_id === null)
  );
}

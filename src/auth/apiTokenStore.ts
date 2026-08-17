import type { RedisType } from "../redis/client.js";
import { decrypt, encrypt } from "./encryption.js";
import { logger } from "../utils/logger.js";
import { CredentialStoreUnreadableError } from "./tokenStore.js";

export interface StoredApiToken {
  account_id: string;
  email: string;
  token: string;
  /** Optional. If set, restricts where this credential can be used. */
  cloud_id: string | null;
  /** Optional site_url (e.g., "acme.atlassian.net") — useful for direct REST calls. */
  site_url: string | null;
  /** Stored verbatim from a successful /myself probe. */
  display_name: string | null;
  added_at: number;
}

export class ApiTokenStore {
  constructor(
    private readonly redis: RedisType,
    private readonly key: Buffer,
  ) {}

  private k(accountId: string): string {
    return `apitoken:${accountId}`;
  }

  async get(accountId: string): Promise<StoredApiToken | null> {
    const blob = await this.redis.get(this.k(accountId));
    if (!blob) return null;
    try {
      const json = decrypt(blob, this.key);
      const token = JSON.parse(json) as unknown;
      if (!isStoredApiToken(token)) throw new Error("stored API credential has an invalid shape");
      return token;
    } catch {
      logger.warn(
        { accountId, credential: "api_token", reason: "decode_failed" },
        "Stored credential could not be read; preserving encrypted entry",
      );
      throw new CredentialStoreUnreadableError("api_token");
    }
  }

  async put(token: StoredApiToken): Promise<void> {
    const blob = encrypt(JSON.stringify(token), this.key);
    // No TTL — manual revoke only.
    await this.redis.set(this.k(token.account_id), blob);
  }

  async delete(accountId: string): Promise<void> {
    await this.redis.del(this.k(accountId));
  }
}

function isStoredApiToken(value: unknown): value is StoredApiToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Partial<StoredApiToken>;
  return (
    typeof token.account_id === "string" &&
    typeof token.email === "string" &&
    typeof token.token === "string" &&
    (typeof token.cloud_id === "string" || token.cloud_id === null) &&
    (typeof token.site_url === "string" || token.site_url === null) &&
    (typeof token.display_name === "string" || token.display_name === null) &&
    typeof token.added_at === "number" &&
    Number.isFinite(token.added_at)
  );
}

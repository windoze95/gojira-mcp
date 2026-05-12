import type { RedisType } from "../redis/client.js";
import { decrypt, encrypt } from "./encryption.js";
import { logger } from "../utils/logger.js";

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
      return JSON.parse(json) as StoredApiToken;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), accountId },
        "API token decrypt failed; purging",
      );
      await this.redis.del(this.k(accountId));
      return null;
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

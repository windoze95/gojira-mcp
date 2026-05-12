import type { RedisType } from "../redis/client.js";
import { decrypt, encrypt } from "./encryption.js";
import { logger } from "../utils/logger.js";

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

const STORED_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d sliding

export class TokenStore {
  constructor(
    private readonly redis: RedisType,
    private readonly key: Buffer,
  ) {}

  private k(accountId: string): string {
    return `token:${accountId}`;
  }

  async get(accountId: string): Promise<StoredToken | null> {
    const blob = await this.redis.get(this.k(accountId));
    if (!blob) return null;
    try {
      const json = decrypt(blob, this.key);
      return JSON.parse(json) as StoredToken;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          accountId,
        },
        "Stored token decrypt failed; purging corrupt entry",
      );
      await this.redis.del(this.k(accountId));
      return null;
    }
  }

  async put(token: StoredToken): Promise<void> {
    const blob = encrypt(JSON.stringify(token), this.key);
    await this.redis.set(this.k(token.account_id), blob, "EX", STORED_TOKEN_TTL_SECONDS);
  }

  async delete(accountId: string): Promise<void> {
    await this.redis.del(this.k(accountId));
  }
}

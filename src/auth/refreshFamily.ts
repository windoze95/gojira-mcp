import type { RedisType } from "../redis/client.js";
import axios from "axios";
import { logger } from "../utils/logger.js";

/**
 * D1 — MCP refresh tokens are rotated on every use. Each rotation belongs to a
 * "family" so we can detect reuse: presentation of a previously rotated-away
 * RT, while other RTs from the same family are still alive, indicates theft.
 *
 * Layout:
 *   refresh_family:<familyId> = SET of currently-live RT ids in the family
 *   mcp_refresh:<rt> = { ..., familyId, generation }
 *   mcp_token:<at> = { ..., familyId } (so we can revoke all live ATs on reuse)
 *   refresh_family_tokens:<familyId> = SET of live AT ids (for revocation)
 */

const FAMILY_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d, matches RT lifetime.

export class RefreshFamily {
  constructor(private readonly redis: RedisType) {}

  familyKey(familyId: string): string {
    return `refresh_family:${familyId}`;
  }
  accessTokensKey(familyId: string): string {
    return `refresh_family_tokens:${familyId}`;
  }

  async addRefreshToken(familyId: string, refreshTokenId: string): Promise<void> {
    const key = this.familyKey(familyId);
    await this.redis.sadd(key, refreshTokenId);
    await this.redis.expire(key, FAMILY_TTL_SECONDS);
  }

  async removeRefreshToken(familyId: string, refreshTokenId: string): Promise<void> {
    await this.redis.srem(this.familyKey(familyId), refreshTokenId);
  }

  async addAccessToken(familyId: string, accessTokenId: string): Promise<void> {
    const key = this.accessTokensKey(familyId);
    await this.redis.sadd(key, accessTokenId);
    await this.redis.expire(key, FAMILY_TTL_SECONDS);
  }

  /**
   * Returns true when the family still has at least one live RT — used by
   * the rotation path to decide whether an unknown RT presentation is reuse.
   */
  async hasOtherLiveRefreshTokens(familyId: string): Promise<boolean> {
    const n = await this.redis.scard(this.familyKey(familyId));
    return n > 0;
  }

  async listRefreshTokens(familyId: string): Promise<string[]> {
    return this.redis.smembers(this.familyKey(familyId));
  }
  async listAccessTokens(familyId: string): Promise<string[]> {
    return this.redis.smembers(this.accessTokensKey(familyId));
  }

  /**
   * Burn the entire family — every RT and every AT — and emit an audit-grade
   * warning. Used on reuse detection.
   */
  async destroyFamily(
    familyId: string,
    opts: { reason: string; accountId?: string; webhookUrl?: string | null },
  ): Promise<{ refreshTokensRevoked: number; accessTokensRevoked: number }> {
    const refreshTokens = await this.listRefreshTokens(familyId);
    const accessTokens = await this.listAccessTokens(familyId);

    const pipeline = this.redis.pipeline();
    for (const rt of refreshTokens) pipeline.del(`mcp_refresh:${rt}`);
    for (const at of accessTokens) pipeline.del(`mcp_token:${at}`);
    pipeline.del(this.familyKey(familyId));
    pipeline.del(this.accessTokensKey(familyId));
    await pipeline.exec();

    logger.warn(
      {
        event: "REFRESH_TOKEN_REUSE",
        familyId,
        accountId: opts.accountId,
        reason: opts.reason,
        refresh_tokens_revoked: refreshTokens.length,
        access_tokens_revoked: accessTokens.length,
      },
      "Refresh token reuse detected; family revoked",
    );

    if (opts.webhookUrl) {
      try {
        await axios.post(
          opts.webhookUrl,
          {
            event: "REFRESH_TOKEN_REUSE",
            family_id: familyId,
            account_id: opts.accountId ?? null,
            reason: opts.reason,
            refresh_tokens_revoked: refreshTokens.length,
            access_tokens_revoked: accessTokens.length,
            ts: new Date().toISOString(),
          },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Refresh reuse webhook delivery failed",
        );
      }
    }

    return { refreshTokensRevoked: refreshTokens.length, accessTokensRevoked: accessTokens.length };
  }
}

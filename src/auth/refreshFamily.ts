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

export type RefreshReusePolicy = "strict" | "contain";
export type RefreshReuseAction = "family_revoked" | "family_preserved";

export interface RefreshReuseReportOptions {
  reason: string;
  accountId?: string;
  clientId?: string;
  webhookUrl?: string | null;
  policy?: RefreshReusePolicy;
  action?: RefreshReuseAction;
}

export interface RefreshReuseCounts {
  refreshTokensRevoked: number;
  accessTokensRevoked: number;
  liveRefreshTokens?: number;
  liveAccessTokens?: number;
}

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
    opts: RefreshReuseReportOptions,
  ): Promise<{ refreshTokensRevoked: number; accessTokensRevoked: number }> {
    const refreshTokens = await this.listRefreshTokens(familyId);
    const accessTokens = await this.listAccessTokens(familyId);

    const pipeline = this.redis.pipeline();
    for (const rt of refreshTokens) pipeline.del(`mcp_refresh:${rt}`);
    for (const at of accessTokens) pipeline.del(`mcp_token:${at}`);
    pipeline.del(this.familyKey(familyId));
    pipeline.del(this.accessTokensKey(familyId));
    await pipeline.exec();

    const counts = {
      refreshTokensRevoked: refreshTokens.length,
      accessTokensRevoked: accessTokens.length,
    };
    await this.reportReuse(familyId, opts, counts);
    return counts;
  }

  /**
   * Emit the audit-grade reuse signal after a caller has already revoked the
   * family atomically (the refresh-rotation Lua path), or after destroyFamily's
   * compatibility path completes.
   */
  async reportReuse(
    familyId: string,
    opts: RefreshReuseReportOptions,
    counts: RefreshReuseCounts,
  ): Promise<void> {
    const policy = opts.policy ?? "strict";
    const action = opts.action ?? "family_revoked";
    const contained = action === "family_preserved";
    const event = contained ? "REFRESH_TOKEN_REUSE_CONTAINED" : "REFRESH_TOKEN_REUSE";

    logger.warn(
      {
        event,
        familyId,
        accountId: opts.accountId,
        clientId: opts.clientId,
        policy,
        action,
        reason: opts.reason,
        refresh_tokens_revoked: counts.refreshTokensRevoked,
        access_tokens_revoked: counts.accessTokensRevoked,
        ...(counts.liveRefreshTokens !== undefined
          ? { live_refresh_tokens: counts.liveRefreshTokens }
          : {}),
        ...(counts.liveAccessTokens !== undefined
          ? { live_access_tokens: counts.liveAccessTokens }
          : {}),
      },
      contained
        ? "Stale refresh token contained; live family preserved"
        : "Refresh token reuse detected; family revoked",
    );

    if (opts.webhookUrl) {
      try {
        await axios.post(
          opts.webhookUrl,
          {
            event,
            family_id: familyId,
            account_id: opts.accountId ?? null,
            client_id: opts.clientId ?? null,
            policy,
            action,
            reason: opts.reason,
            refresh_tokens_revoked: counts.refreshTokensRevoked,
            access_tokens_revoked: counts.accessTokensRevoked,
            ...(counts.liveRefreshTokens !== undefined
              ? { live_refresh_tokens: counts.liveRefreshTokens }
              : {}),
            ...(counts.liveAccessTokens !== undefined
              ? { live_access_tokens: counts.liveAccessTokens }
              : {}),
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
  }
}

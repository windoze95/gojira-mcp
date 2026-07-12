import { randomUUID } from "node:crypto";
import type { RedisType } from "../redis/client.js";
import type { AppConfig } from "../config.js";
import { TokenStore, type StoredToken } from "./tokenStore.js";
import { refreshAtlassianTokens } from "../atlassian/identity.js";
import { logger } from "../utils/logger.js";
import { AuthExpiredError, AuthRequiredError } from "../middleware/errorHandler.js";

/** Refresh if the access token expires within this many ms. */
const REFRESH_GUARD_MS = 60_000;
// Must exceed the upstream refresh HTTP timeout (15s in identity.ts) plus
// margin, or the lock can expire mid-refresh and let a second refresher burn
// the (single-use) Atlassian refresh grant.
const LOCK_TTL_SECONDS = 30;
/** How long a contending caller waits for the lock holder to publish a fresh token. */
const CONTENTION_MAX_WAIT_MS = 20_000;
const CONTENTION_POLL_MS = 500;

/**
 * Lua compare-and-delete: only release the lock if we still own it.
 */
const CAD_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class TokenRefresher {
  private readonly tokens: TokenStore;

  constructor(
    private readonly redis: RedisType,
    private readonly config: AppConfig,
  ) {
    this.tokens = new TokenStore(redis, config.tokenEncryptionKey);
  }

  /**
   * Ensures the upstream Atlassian access token is fresh. Returns the StoredToken.
   *
   * Implements handoff §2.4: distributed lock with compare-and-delete, sleep-on-contention,
   * double-check after acquiring lock.
   */
  async ensureFreshToken(accountId: string): Promise<StoredToken> {
    const stored = await this.tokens.get(accountId);
    if (!stored) throw new AuthRequiredError("No upstream credential on file");

    if (stored.expires_at - Date.now() > REFRESH_GUARD_MS) {
      return stored;
    }
    if (!stored.refresh_token) {
      // Nothing to refresh with; force re-auth.
      throw new AuthExpiredError("Upstream credential expired and no refresh token available");
    }

    const lockKey = `token_refresh_lock:${accountId}`;
    const lockToken = randomUUID();
    const acquired = await this.redis.set(lockKey, lockToken, "EX", LOCK_TTL_SECONDS, "NX");

    if (acquired !== "OK") {
      // Another caller holds the lock. Poll until it publishes a fresh token,
      // the lock is released (holder finished or died — then we retry), or we
      // exhaust the wait budget. A single short sleep + throw (the old behavior)
      // spuriously forced re-auth on every parallel tool call at refresh time.
      const deadline = Date.now() + CONTENTION_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(CONTENTION_POLL_MS);
        const fresh = await this.tokens.get(accountId);
        if (!fresh) throw new AuthRequiredError("Upstream credential disappeared during refresh");
        if (fresh.expires_at - Date.now() > REFRESH_GUARD_MS) return fresh;
        // Holder gone without publishing a fresh token → attempt to take over.
        const lockStillHeld = await this.redis.exists(lockKey);
        if (!lockStillHeld) return this.ensureFreshToken(accountId);
      }
      throw new AuthExpiredError("Token refresh contention timed out");
    }

    try {
      // Double-check inside the critical section.
      const recheck = await this.tokens.get(accountId);
      if (!recheck) throw new AuthRequiredError("Upstream credential disappeared");
      if (recheck.expires_at - Date.now() > REFRESH_GUARD_MS) return recheck;
      const refreshToken = recheck.refresh_token;
      if (!refreshToken) throw new AuthExpiredError("No refresh token");

      let resp;
      try {
        resp = await refreshAtlassianTokens({
          clientId: this.config.atlassian.clientId,
          clientSecret: this.config.atlassian.clientSecret,
          refreshToken,
        });
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 400 || status === 401) {
          await this.tokens.delete(accountId);
          logger.warn({ accountId, status }, "Upstream rejected refresh; purging stored token");
          throw new AuthExpiredError("Upstream rejected refresh; re-authentication required");
        }
        throw err;
      }

      const next: StoredToken = {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token ?? recheck.refresh_token,
        expires_at: Date.now() + resp.expires_in * 1000,
        account_id: recheck.account_id,
        name: recheck.name,
        email: recheck.email,
        accessible_cloud_ids: recheck.accessible_cloud_ids,
        primary_cloud_id: recheck.primary_cloud_id,
      };
      await this.tokens.put(next);
      return next;
    } finally {
      // CAD release.
      await this.redis.eval(CAD_SCRIPT, 1, lockKey, lockToken).catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to release refresh lock (best-effort)",
        );
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

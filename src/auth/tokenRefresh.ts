import { randomUUID } from "node:crypto";
import type { RedisType } from "../redis/client.js";
import type { AppConfig } from "../config.js";
import { TokenStore, type StoredToken } from "./tokenStore.js";
import { refreshAtlassianTokens } from "../atlassian/identity.js";
import { logger } from "../utils/logger.js";
import {
  AuthExpiredError,
  AuthRequiredError,
  UpstreamUnavailableError,
} from "../middleware/errorHandler.js";

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
    const initial = await this.tokens.getSnapshot(accountId);
    if (!initial) throw new AuthRequiredError("No upstream credential on file");
    const stored = initial.token;

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
      throw new UpstreamUnavailableError(
        "Atlassian credential refresh is temporarily busy; retry later.",
        { reason: "REFRESH_CONTENTION_TIMEOUT" },
      );
    }

    try {
      // Double-check inside the critical section.
      const recheckSnapshot = await this.tokens.getSnapshot(accountId);
      if (!recheckSnapshot) throw new AuthRequiredError("Upstream credential disappeared");
      const recheck = recheckSnapshot.token;
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
        const oauthFailure = describeOAuthFailure(err);
        if (oauthFailure.isInvalidGrant) {
          const deleted = await this.tokens.deleteIfUnchanged(
            accountId,
            recheckSnapshot.version,
          );
          if (!deleted) {
            // A callback/login replaced the credential while the old refresh
            // request was in flight. The newer login wins; never delete it or
            // report the stale request's invalid_grant to the caller.
            const replacement = await this.tokens.get(accountId);
            if (replacement) {
              logger.info(
                { accountId },
                "Adopting credential written during an in-flight invalid_grant response",
              );
              return replacement;
            }
          }
          logger.warn(
            { accountId, status: oauthFailure.status },
            "Atlassian rejected the current refresh grant; removed matching credential",
          );
          throw new AuthExpiredError("Upstream rejected refresh; re-authentication required");
        }
        logger.warn(
          {
            accountId,
            status: oauthFailure.status,
            oauthError: oauthFailure.safeCode,
          },
          "Atlassian refresh failed; preserving stored credential",
        );
        throw new UpstreamUnavailableError(
          "Atlassian credential refresh failed; the existing credential was preserved.",
          {
            reason: "UPSTREAM_REFRESH_FAILED",
            status: oauthFailure.status,
            oauth_error: oauthFailure.safeCode,
          },
        );
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
      const persisted = await this.tokens.putIfUnchanged(
        next,
        recheckSnapshot.version,
      );
      if (persisted) return next;

      // The refresh succeeded, but a callback/login replaced the old snapshot
      // before we could persist it. Adopt that newer credential instead of
      // overwriting it with a response derived from the old refresh grant.
      const replacement = await this.tokens.get(accountId);
      if (replacement) {
        logger.info(
          { accountId },
          "Adopting credential written during an in-flight refresh",
        );
        return replacement;
      }
      throw new AuthRequiredError("Upstream credential disappeared during refresh");
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

interface OAuthFailureDescription {
  status: number | null;
  safeCode: string;
  isInvalidGrant: boolean;
}

const SAFE_OAUTH_ERROR_CODES = new Set([
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
]);

/** Extract only bounded OAuth metadata; never surface upstream descriptions. */
function describeOAuthFailure(err: unknown): OAuthFailureDescription {
  const response = (err as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const status = typeof response?.status === "number" ? response.status : null;
  const data = response?.data;
  const code =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { error?: unknown }).error
      : null;
  const oauthCode = typeof code === "string" ? code : null;
  const isClientError = status !== null && status >= 400 && status < 500;
  return {
    status,
    safeCode:
      oauthCode && SAFE_OAUTH_ERROR_CODES.has(oauthCode)
        ? oauthCode
        : oauthCode === "invalid_grant"
          ? "invalid_grant"
          : "unclassified",
    // Purging is deliberately narrower than status-based handling: only an
    // actual OAuth invalid_grant response proves this stored grant is dead.
    isInvalidGrant: isClientError && oauthCode === "invalid_grant",
  };
}

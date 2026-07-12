import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RedisType } from "../redis/client.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  AccessDeniedError,
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { RedisClientsStore } from "./clientsStore.js";
import { RefreshFamily } from "./refreshFamily.js";
import { logger } from "../utils/logger.js";
import type { AppConfig } from "../config.js";

const PENDING_TTL = 10 * 60;
const STATE_TTL = 10 * 60;
const AUTH_CODE_TTL = 5 * 60;
const MCP_ACCESS_TTL = 60 * 60;
const MCP_REFRESH_TTL = 30 * 24 * 60 * 60;
/** Slightly longer than the RT so we can detect reuse for a grace window. */
const RT_FAMILY_INDEX_TTL = 31 * 24 * 60 * 60;

export interface PendingAuth {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  /** State passed by the MCP client. We hand it back on the final hop. */
  state: string | undefined;
  /** Atlassian-side scopes we asked for. */
  atlassianScopes: string[];
  createdAt: number;
}

export interface MintedAuthCode {
  accountId: string;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
}

interface StoredAccessToken {
  accountId: string;
  clientId: string;
  expiresAt: number; // unix-seconds
  familyId: string;
}

interface StoredRefreshToken {
  accountId: string;
  clientId: string;
  familyId: string;
  generation: number;
}

export interface MintMcpTokensOpts {
  accountId: string;
  clientId: string;
  /** When provided, reuse this family on rotation; else mint a new family. */
  familyId?: string;
  generation?: number;
}

export interface OAuthProviderDeps {
  redis: RedisType;
  config: AppConfig;
}

export class GojiraOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: RedisClientsStore;
  private readonly redis: RedisType;
  private readonly config: AppConfig;
  private readonly family: RefreshFamily;

  constructor(deps: OAuthProviderDeps) {
    this.redis = deps.redis;
    this.config = deps.config;
    this.clientsStore = new RedisClientsStore(deps.redis);
    this.family = new RefreshFamily(deps.redis);
  }

  static keys = {
    pendingAuth: (id: string) => `pending_auth:${id}`,
    atlassianState: (state: string) => `atlassian_state:${state}`,
    authCode: (code: string) => `auth_code:${code}`,
    mcpAccess: (token: string) => `mcp_token:${token}`,
    mcpRefresh: (token: string) => `mcp_refresh:${token}`,
    rtFamilyIndex: (token: string) => `rt_family:${token}`,
    familyAccount: (familyId: string) => `rt_family_account:${familyId}`,
  };

  // -------- /authorize handler --------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const atlassianScopes = this.config.atlassian.scopes;

    const pendingAuthId = randomBytes(16).toString("hex");
    const atlassianState = randomBytes(32).toString("hex");

    const pending: PendingAuth = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      atlassianScopes,
      createdAt: Date.now(),
    };
    await this.redis.set(
      GojiraOAuthProvider.keys.pendingAuth(pendingAuthId),
      JSON.stringify(pending),
      "EX",
      PENDING_TTL,
    );
    await this.redis.set(
      GojiraOAuthProvider.keys.atlassianState(atlassianState),
      JSON.stringify({ pendingAuthId }),
      "EX",
      STATE_TTL,
    );

    const url = new URL("https://auth.atlassian.com/authorize");
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("client_id", this.config.atlassian.clientId);
    url.searchParams.set("scope", atlassianScopes.join(" "));
    url.searchParams.set("redirect_uri", this.config.atlassian.callbackUri);
    url.searchParams.set("state", atlassianState);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "consent");

    res.redirect(302, url.toString());
  }

  // -------- /token handler (called by the SDK) --------

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const blob = await this.redis.get(GojiraOAuthProvider.keys.authCode(authorizationCode));
    if (!blob) {
      throw new InvalidGrantError("authorization code is invalid or expired");
    }
    const code = JSON.parse(blob) as MintedAuthCode;
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const blob = await this.getdel(GojiraOAuthProvider.keys.authCode(authorizationCode));
    if (!blob) {
      throw new InvalidGrantError("authorization code is invalid or already used");
    }
    const code = JSON.parse(blob) as MintedAuthCode;

    if (code.clientId !== client.client_id) {
      throw new InvalidClientError("client_id mismatch for this authorization code");
    }
    if (redirectUri && code.redirectUri !== redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    const tokens = await this.mintMcpTokens({
      accountId: code.accountId,
      clientId: client.client_id,
    });
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
  ): Promise<OAuthTokens> {
    const rtKey = GojiraOAuthProvider.keys.mcpRefresh(refreshToken);
    // Atomically claim the RT: only one caller can win. A concurrent replay
    // (attacker racing the legitimate holder) loses the GETDEL and falls into
    // the reuse-detection branch — plain GET would let both requests succeed
    // and silently leave two live RTs in the family, defeating the alarm.
    const stored = await this.getdel(rtKey);
    if (!stored) {
      const fIdx = await this.redis.get(GojiraOAuthProvider.keys.rtFamilyIndex(refreshToken));
      if (fIdx) {
        const familyId = this.parseFamilyIndex(fIdx);
        const hasOthers = await this.family.hasOtherLiveRefreshTokens(familyId);
        if (hasOthers) {
          const accountId = await this.redis.get(
            GojiraOAuthProvider.keys.familyAccount(familyId),
          );
          await this.family.destroyFamily(familyId, {
            reason:
              "Refresh token reuse: presented previously-rotated RT while family still has live members.",
            accountId: accountId ?? undefined,
            webhookUrl: this.config.refreshReuseAlertWebhook,
          });
        }
      }
      throw new InvalidGrantError("refresh token is invalid or revoked");
    }
    const rt = JSON.parse(stored) as StoredRefreshToken;
    if (rt.clientId !== client.client_id) {
      throw new InvalidClientError("refresh token was issued to a different client");
    }

    // RT is already consumed by the GETDEL above; drop it from the family set.
    await this.family.removeRefreshToken(rt.familyId, refreshToken);

    const upstreamKey = `token:${rt.accountId}`;
    const upstreamExists = await this.redis.exists(upstreamKey);
    if (!upstreamExists) {
      throw new InvalidGrantError("upstream credential is no longer present; re-authenticate");
    }

    const minted = await this.mintMcpTokens({
      accountId: rt.accountId,
      clientId: rt.clientId,
      familyId: rt.familyId,
      generation: rt.generation + 1,
    });

    return minted;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const blob = await this.redis.get(GojiraOAuthProvider.keys.mcpAccess(token));
    // Throw InvalidTokenError (not InvalidGrantError) so the bearer-auth
    // middleware answers with 401 + WWW-Authenticate — the signal MCP clients
    // use to refresh. A 400 leaves them stuck without re-authenticating.
    if (!blob) throw new InvalidTokenError("access token is invalid or expired");
    const at = JSON.parse(blob) as StoredAccessToken;
    const nowSec = Math.floor(Date.now() / 1000);
    if (at.expiresAt <= nowSec) {
      await this.redis.del(GojiraOAuthProvider.keys.mcpAccess(token));
      throw new InvalidTokenError("access token has expired");
    }
    return {
      token,
      clientId: at.clientId,
      scopes: [],
      expiresAt: at.expiresAt,
      extra: {
        accountId: at.accountId,
        familyId: at.familyId,
      },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tok = request.token;
    const accessKey = GojiraOAuthProvider.keys.mcpAccess(tok);
    const refreshKey = GojiraOAuthProvider.keys.mcpRefresh(tok);
    const [aBlob, rBlob] = await Promise.all([this.redis.get(accessKey), this.redis.get(refreshKey)]);
    if (aBlob) {
      const a = JSON.parse(aBlob) as StoredAccessToken;
      if (a.clientId !== client.client_id) throw new AccessDeniedError("token does not belong to this client");
      await this.redis.del(accessKey);
    }
    if (rBlob) {
      const r = JSON.parse(rBlob) as StoredRefreshToken;
      if (r.clientId !== client.client_id) throw new AccessDeniedError("token does not belong to this client");
      await this.redis.del(refreshKey);
      await this.family.removeRefreshToken(r.familyId, tok);
    }
  }

  // -------- Helpers (used by callback + internal rotation) --------

  async storeAuthCode(code: string, payload: MintedAuthCode): Promise<void> {
    await this.redis.set(
      GojiraOAuthProvider.keys.authCode(code),
      JSON.stringify(payload),
      "EX",
      AUTH_CODE_TTL,
    );
  }

  async consumeAtlassianState(state: string): Promise<{ pendingAuthId: string } | null> {
    const raw = await this.getdel(GojiraOAuthProvider.keys.atlassianState(state));
    if (!raw) return null;
    return JSON.parse(raw) as { pendingAuthId: string };
  }

  /** Atomic read-and-delete (Redis GETDEL). Used for one-time-use artifacts (codes, state, RTs). */
  private getdel(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }

  /**
   * The rt_family index historically stored the bare familyId string; we keep
   * that format so existing tokens keep working. Parse defensively in case a
   * future format is introduced.
   */
  private parseFamilyIndex(raw: string): string {
    if (raw.startsWith("{")) {
      try {
        const o = JSON.parse(raw) as { familyId?: string };
        if (o.familyId) return o.familyId;
      } catch {
        /* fall through */
      }
    }
    return raw;
  }

  async getPendingAuth(id: string): Promise<PendingAuth | null> {
    const raw = await this.redis.get(GojiraOAuthProvider.keys.pendingAuth(id));
    if (!raw) return null;
    return JSON.parse(raw) as PendingAuth;
  }

  async deletePendingAuth(id: string): Promise<void> {
    await this.redis.del(GojiraOAuthProvider.keys.pendingAuth(id));
  }

  /**
   * Mint a paired access + refresh token, store both, register them with the
   * family index, and return the OAuth tokens response.
   */
  async mintMcpTokens(opts: MintMcpTokensOpts): Promise<OAuthTokens> {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const familyId = opts.familyId ?? randomUUID();
    const generation = opts.generation ?? 1;

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + MCP_ACCESS_TTL;

    const atVal: StoredAccessToken = {
      accountId: opts.accountId,
      clientId: opts.clientId,
      expiresAt,
      familyId,
    };
    const rtVal: StoredRefreshToken = {
      accountId: opts.accountId,
      clientId: opts.clientId,
      familyId,
      generation,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(GojiraOAuthProvider.keys.mcpAccess(accessToken), JSON.stringify(atVal), "EX", MCP_ACCESS_TTL);
    pipeline.set(GojiraOAuthProvider.keys.mcpRefresh(refreshToken), JSON.stringify(rtVal), "EX", MCP_REFRESH_TTL);
    pipeline.set(
      GojiraOAuthProvider.keys.rtFamilyIndex(refreshToken),
      familyId,
      "EX",
      RT_FAMILY_INDEX_TTL,
    );
    // Family→account map, so reuse detection can attribute the incident to a
    // user even after the presented RT (and its blob) is gone.
    pipeline.set(
      GojiraOAuthProvider.keys.familyAccount(familyId),
      opts.accountId,
      "EX",
      RT_FAMILY_INDEX_TTL,
    );
    await pipeline.exec();

    await this.family.addRefreshToken(familyId, refreshToken);
    await this.family.addAccessToken(familyId, accessToken);

    logger.debug(
      { accountId: opts.accountId, familyId, generation },
      "Minted MCP token pair",
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TTL,
      refresh_token: refreshToken,
    };
  }

  serverError(msg: string): ServerError {
    return new ServerError(msg);
  }
}

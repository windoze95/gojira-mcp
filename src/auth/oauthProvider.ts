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
import { STORED_TOKEN_TTL_SECONDS } from "./tokenStore.js";
import { logger } from "../utils/logger.js";
import type { AppConfig } from "../config.js";

const PENDING_TTL = 10 * 60;
const STATE_TTL = 10 * 60;
const AUTH_CODE_TTL = 5 * 60;
const MCP_ACCESS_TTL = 60 * 60;
const MCP_REFRESH_TTL = 30 * 24 * 60 * 60;
/** Slightly longer than the RT so we can detect reuse for a grace window. */
const RT_FAMILY_INDEX_TTL = 31 * 24 * 60 * 60;
/**
 * A duplicate refresh in this fixed, non-sliding window receives the exact
 * pair minted by the winning request. Keep this deliberately tiny: possession
 * of the old bearer is sufficient to claim the receipt.
 */
const MCP_REFRESH_REPLAY_TTL = 5;
/** Suppress duplicate contained-reuse alerts from a retrying stale process. */
const MCP_REFRESH_REUSE_NOTICE_TTL = 5 * 60;
const REFRESH_FAMILY_TTL = MCP_REFRESH_TTL;

/**
 * One Redis-atomic refresh-family transition.
 *
 * ioredis-mock does not expose Lua's cjson global, so TypeScript parses and
 * validates the immutable JSON records, then passes their exact raw values as
 * compare-and-swap guards. The short replay receipt is a Redis hash so Lua can
 * validate its client/issuer binding without decoding JSON.
 */
const ROTATE_REFRESH_TOKEN_SCRIPT = `
local active_key = KEYS[1]
local replay_key = KEYS[2]
local old_index_key = KEYS[3]
local upstream_key = KEYS[4]
local new_access_key = KEYS[5]
local new_refresh_key = KEYS[6]
local new_index_key = KEYS[7]
local family_account_key = KEYS[8]
local family_refresh_key = KEYS[9]
local family_access_key = KEYS[10]
local reuse_notice_key = KEYS[11]

local expected_active = ARGV[1]
local expected_index = ARGV[2]
local requester_client = ARGV[3]
local requester_issuer = ARGV[4]
local old_refresh_token = ARGV[5]
local new_access_token = ARGV[6]
local new_refresh_token = ARGV[7]
local new_access_value = ARGV[8]
local new_refresh_value = ARGV[9]
local old_index_value = ARGV[10]
local new_index_value = ARGV[11]
local family_id = ARGV[12]
local account_id = ARGV[13]
local generation = ARGV[14]
local access_ttl = tonumber(ARGV[15])
local refresh_ttl = tonumber(ARGV[16])
local index_ttl = tonumber(ARGV[17])
local family_ttl = tonumber(ARGV[18])
local replay_ttl = tonumber(ARGV[19])
local reuse_policy = ARGV[20]
local upstream_ttl = tonumber(ARGV[21])
local reuse_notice_ttl = tonumber(ARGV[22])

-- A receipt is valid only for the immediate child generation. Reading it does
-- not extend its TTL, so repeated retries cannot turn the grace into a sliding
-- replay window.
if redis.call('EXISTS', replay_key) == 1 then
  local replay = redis.call(
    'HMGET',
    replay_key,
    'client_id',
    'issuer',
    'family_id',
    'account_id',
    'generation',
    'access_token',
    'refresh_token',
    'token_type',
    'expires_in'
  )
  if replay[1] ~= requester_client then
    return {'wrong_client'}
  end
  if replay[2] ~= requester_issuer then
    return {'wrong_issuer'}
  end

  local child_access_key = 'mcp_token:' .. replay[6]
  local child_refresh_key = 'mcp_refresh:' .. replay[7]
  local child_family_key = 'refresh_family:' .. replay[3]
  if redis.call('EXISTS', child_access_key) == 1
      and redis.call('EXISTS', child_refresh_key) == 1
      and redis.call('SISMEMBER', child_family_key, replay[7]) == 1 then
    return {
      'replay', replay[6], replay[7], replay[8], replay[9],
      replay[3], replay[4], replay[5]
    }
  end

  -- The child has already rotated or been revoked. An older receipt must never
  -- hand out dead credentials or chain forward to another generation.
  redis.call('DEL', replay_key)
end

local active = redis.call('GET', active_key)
if active then
  if expected_active == '' or active ~= expected_active then
    return {'retry'}
  end

  if redis.call('EXISTS', upstream_key) == 0 then
    redis.call('DEL', active_key)
    redis.call('SREM', family_refresh_key, old_refresh_token)
    return {'upstream_missing'}
  end

  -- An actively rotating MCP client is still an active authenticated user,
  -- even when every tool it calls uses the API-token side channel. Keep the
  -- shared upstream credential available so API-token-only activity cannot
  -- age the MCP family into an artificial logout at the local 90-day TTL.
  redis.call('EXPIRE', upstream_key, upstream_ttl)

  -- Preserve the old index's remaining lifetime while upgrading its value to
  -- the structured client/issuer-bound format used by post-grace detection.
  local old_index_ttl = redis.call('TTL', old_index_key)
  if old_index_ttl > 0 then
    redis.call('SET', old_index_key, old_index_value, 'EX', old_index_ttl)
  else
    redis.call('SET', old_index_key, old_index_value, 'EX', index_ttl)
  end

  redis.call('DEL', active_key)
  redis.call('SREM', family_refresh_key, old_refresh_token)

  redis.call('SET', new_access_key, new_access_value, 'EX', access_ttl)
  redis.call('SET', new_refresh_key, new_refresh_value, 'EX', refresh_ttl)
  redis.call('SET', new_index_key, new_index_value, 'EX', index_ttl)
  redis.call('SET', family_account_key, account_id, 'EX', index_ttl)

  redis.call('SADD', family_refresh_key, new_refresh_token)
  redis.call('EXPIRE', family_refresh_key, family_ttl)
  redis.call('SADD', family_access_key, new_access_token)
  redis.call('EXPIRE', family_access_key, family_ttl)

  redis.call(
    'HSET', replay_key,
    'client_id', requester_client,
    'issuer', requester_issuer,
    'family_id', family_id,
    'account_id', account_id,
    'generation', generation,
    'access_token', new_access_token,
    'refresh_token', new_refresh_token,
    'token_type', 'Bearer',
    'expires_in', access_ttl
  )
  redis.call('EXPIRE', replay_key, replay_ttl)

  return {
    'rotated', new_access_token, new_refresh_token, 'Bearer',
    tostring(access_ttl), family_id, account_id, generation
  }
end

local current_index = redis.call('GET', old_index_key)
if not current_index then
  return {'invalid'}
end
if expected_index == '' or current_index ~= expected_index then
  return {'retry'}
end

local refresh_tokens = redis.call('SMEMBERS', family_refresh_key)
if #refresh_tokens == 0 then
  return {'invalid'}
end
local access_tokens = redis.call('SMEMBERS', family_access_key)

-- Containment is an availability policy for clients that persist a stale
-- parent after losing a refresh response. Never disclose or mint credentials
-- here: preserve the current head and return only sanitized counts for
-- telemetry. Client and issuer binding was verified before this transition.
if reuse_policy == 'contain' then
  local notice_created = redis.call(
    'SET', reuse_notice_key, '1', 'EX', reuse_notice_ttl, 'NX'
  )
  return {
    'contained', family_id, account_id,
    tostring(#refresh_tokens), tostring(#access_tokens),
    notice_created and '1' or '0'
  }
end

-- Revoke the entire current family in this same atomic transition. A racing
-- rotation therefore either happens before this burn and is deleted, or after
-- it and sees no active parent; it can never resurrect the family.
for _, token in ipairs(refresh_tokens) do
  redis.call('DEL', 'mcp_refresh:' .. token)
end
for _, token in ipairs(access_tokens) do
  redis.call('DEL', 'mcp_token:' .. token)
end
redis.call('DEL', family_refresh_key)
redis.call('DEL', family_access_key)

return {
  'reuse', family_id, account_id,
  tostring(#refresh_tokens), tostring(#access_tokens)
}
`;

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
  /**
   * MCP_SERVER_URL of the instance that minted the token. Split-surface
   * profiles share one Redis, so without this check a bearer minted by the
   * read-only instance would authenticate against the write instance —
   * `verifyAccessToken` rejects on mismatch. Absent on tokens minted before
   * the field existed; those are accepted (grandfathered).
   */
  issuer?: string;
}

interface StoredRefreshToken {
  accountId: string;
  clientId: string;
  familyId: string;
  generation: number;
  /** Same contract as StoredAccessToken.issuer. */
  issuer?: string;
}

interface StoredRefreshFamilyIndex {
  v?: number;
  familyId: string;
  clientId?: string;
  issuer?: string;
  generation?: number;
}

type RefreshScriptResult = [
  status: string,
  ...values: string[],
];

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
    mcpRefreshReplay: (token: string) => `mcp_refresh_replay:${token}`,
    mcpRefreshReuseNotice: (token: string) => `mcp_refresh_reuse_notice:${token}`,
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
    const indexKey = GojiraOAuthProvider.keys.rtFamilyIndex(refreshToken);

    // The script uses exact raw values as compare-and-swap guards, but JSON
    // validation remains here where malformed records and legacy formats can be
    // handled clearly. Retry only when one of those immutable records changed
    // between this read and the atomic transition.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [activeRaw, indexRaw] = await this.redis.mget(rtKey, indexKey);
      const active = activeRaw ? this.parseStoredRefreshToken(activeRaw) : null;
      const index = indexRaw ? this.parseFamilyIndex(indexRaw) : null;

      if (!active && !index) {
        throw new InvalidGrantError("refresh token is invalid or revoked");
      }

      if (active) {
        this.assertRefreshBinding(active, client);
        if (active.issuer === undefined) {
          logger.warn(
            { accountId: active.accountId, clientId: active.clientId },
            "Refresh token has no issuer stamp (minted pre-upgrade); accepting and re-minting with one",
          );
        }
      } else if (index) {
        // A legacy bare family index has no client or issuer binding. It is
        // enough to reject the stale bearer, but not enough evidence to burn a
        // live family in a shared-Redis fleet: any sibling (or different
        // client) could otherwise turn it into a cross-instance DoS. Active
        // legacy RTs remain accepted above and upgrade their index on rotation.
        if (index.clientId === undefined || index.issuer === undefined) {
          logger.warn(
            { familyId: index.familyId },
            "Stale refresh token has an unbound legacy family index; refusing family revocation",
          );
          throw new InvalidGrantError("refresh token is invalid or revoked");
        }
        this.assertRefreshIndexBinding(index, client);
      }

      const familyId = active?.familyId ?? index!.familyId;
      const accountId =
        active?.accountId ??
        (await this.redis.get(GojiraOAuthProvider.keys.familyAccount(familyId))) ??
        "";
      const generation = (active?.generation ?? index?.generation ?? 0) + 1;
      const accessToken = randomBytes(32).toString("hex");
      const nextRefreshToken = randomBytes(32).toString("hex");
      const nowSec = Math.floor(Date.now() / 1000);

      const atVal: StoredAccessToken = {
        accountId,
        clientId: client.client_id,
        expiresAt: nowSec + MCP_ACCESS_TTL,
        familyId,
        issuer: this.config.mcpServerUrl,
      };
      const rtVal: StoredRefreshToken = {
        accountId,
        clientId: client.client_id,
        familyId,
        generation,
        issuer: this.config.mcpServerUrl,
      };
      const oldIndexVal = this.serializeFamilyIndex({
        familyId,
        clientId: active?.clientId ?? index?.clientId ?? client.client_id,
        issuer: active?.issuer ?? index?.issuer ?? this.config.mcpServerUrl,
        generation: active?.generation ?? index?.generation,
      });
      const nextIndexVal = this.serializeFamilyIndex({
        familyId,
        clientId: client.client_id,
        issuer: this.config.mcpServerUrl,
        generation,
      });

      const result = (await this.redis.eval(
        ROTATE_REFRESH_TOKEN_SCRIPT,
        11,
        rtKey,
        GojiraOAuthProvider.keys.mcpRefreshReplay(refreshToken),
        indexKey,
        `token:${accountId}`,
        GojiraOAuthProvider.keys.mcpAccess(accessToken),
        GojiraOAuthProvider.keys.mcpRefresh(nextRefreshToken),
        GojiraOAuthProvider.keys.rtFamilyIndex(nextRefreshToken),
        GojiraOAuthProvider.keys.familyAccount(familyId),
        this.family.familyKey(familyId),
        this.family.accessTokensKey(familyId),
        GojiraOAuthProvider.keys.mcpRefreshReuseNotice(refreshToken),
        activeRaw ?? "",
        indexRaw ?? "",
        client.client_id,
        this.config.mcpServerUrl,
        refreshToken,
        accessToken,
        nextRefreshToken,
        JSON.stringify(atVal),
        JSON.stringify(rtVal),
        oldIndexVal,
        nextIndexVal,
        familyId,
        accountId,
        generation.toString(),
        MCP_ACCESS_TTL.toString(),
        MCP_REFRESH_TTL.toString(),
        RT_FAMILY_INDEX_TTL.toString(),
        REFRESH_FAMILY_TTL.toString(),
        MCP_REFRESH_REPLAY_TTL.toString(),
        this.config.refreshReusePolicy ?? "strict",
        STORED_TOKEN_TTL_SECONDS.toString(),
        MCP_REFRESH_REUSE_NOTICE_TTL.toString(),
      )) as RefreshScriptResult;

      const [status, ...values] = result;
      if (status === "retry") continue;
      if (status === "wrong_client") {
        throw new InvalidClientError("refresh token was issued to a different client");
      }
      if (status === "wrong_issuer") {
        throw new InvalidGrantError(
          "refresh token was issued by a different gojira-mcp instance",
        );
      }
      if (status === "upstream_missing") {
        throw new InvalidGrantError("upstream credential is no longer present; re-authenticate");
      }
      if (status === "invalid") {
        throw new InvalidGrantError("refresh token is invalid or revoked");
      }
      if (status === "reuse" || status === "contained") {
        const [reusedFamilyId, reusedAccountId, rtCount, atCount, reportFlag] = values;
        const contained = status === "contained";
        if (!contained || reportFlag === "1") {
          await this.family.reportReuse(
            reusedFamilyId!,
            {
              reason:
                "Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.",
              accountId: reusedAccountId || undefined,
              clientId: client.client_id,
              webhookUrl: this.config.refreshReuseAlertWebhook,
              policy: contained ? "contain" : "strict",
              action: contained ? "family_preserved" : "family_revoked",
            },
            {
              refreshTokensRevoked: contained ? 0 : Number(rtCount),
              accessTokensRevoked: contained ? 0 : Number(atCount),
              ...(contained
                ? {
                    liveRefreshTokens: Number(rtCount),
                    liveAccessTokens: Number(atCount),
                  }
                : {}),
            },
          );
        }
        if (contained) {
          throw new ServerError(
            "Refresh retry could not be completed safely; retry with the latest stored credentials",
          );
        }
        throw new InvalidGrantError("refresh token is invalid or revoked");
      }
      if (status === "rotated" || status === "replay") {
        const [returnedAccess, returnedRefresh, tokenType, expiresIn, resultFamilyId, resultAccountId, resultGeneration] =
          values;
        if (status === "replay") {
          logger.info(
            {
              event: "REFRESH_TOKEN_IDEMPOTENT_REPLAY",
              familyId: resultFamilyId,
              accountId: resultAccountId,
              clientId: client.client_id,
              generation: Number(resultGeneration),
            },
            "Concurrent refresh-token replay accepted within idempotency window",
          );
        } else {
          logger.debug(
            {
              accountId: resultAccountId,
              familyId: resultFamilyId,
              generation: Number(resultGeneration),
            },
            "Minted MCP token pair",
          );
        }
        return {
          access_token: returnedAccess!,
          token_type: tokenType!,
          expires_in: Number(expiresIn),
          refresh_token: returnedRefresh!,
        };
      }

      throw new ServerError("refresh-token rotation returned an unknown state");
    }

    throw new ServerError("refresh-token rotation contention did not settle");
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
    // Cross-instance guard (shared-Redis split-surface deployments): a token
    // minted by a sibling instance is valid THERE, so reject without deleting.
    if (at.issuer === undefined) {
      logger.debug(
        { accountId: at.accountId, clientId: at.clientId },
        "Access token has no issuer stamp (minted pre-upgrade); accepting",
      );
    } else if (at.issuer !== this.config.mcpServerUrl) {
      throw new InvalidTokenError("access token was issued by a different gojira-mcp instance");
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

  /** Atomic read-and-delete (Redis GETDEL) for one-time auth codes and state. */
  private getdel(key: string): Promise<string | null> {
    return this.redis.getdel(key);
  }

  private parseStoredRefreshToken(raw: string): StoredRefreshToken {
    try {
      const token = JSON.parse(raw) as Partial<StoredRefreshToken>;
      if (
        typeof token.accountId !== "string" ||
        typeof token.clientId !== "string" ||
        typeof token.familyId !== "string" ||
        typeof token.generation !== "number"
      ) {
        throw new Error("required fields are missing");
      }
      return token as StoredRefreshToken;
    } catch (err) {
      throw new ServerError(
        `stored refresh token is malformed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Legacy indexes are bare family ids; newly written indexes are bound. */
  private parseFamilyIndex(raw: string): StoredRefreshFamilyIndex {
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredRefreshFamilyIndex>;
        if (typeof parsed.familyId === "string") {
          return parsed as StoredRefreshFamilyIndex;
        }
      } catch {
        /* fall through */
      }
    }
    return { familyId: raw };
  }

  private serializeFamilyIndex(index: StoredRefreshFamilyIndex): string {
    return JSON.stringify({
      v: 2,
      familyId: index.familyId,
      clientId: index.clientId,
      issuer: index.issuer,
      generation: index.generation,
    });
  }

  private assertRefreshBinding(
    token: StoredRefreshToken,
    client: OAuthClientInformationFull,
  ): void {
    if (token.clientId !== client.client_id) {
      throw new InvalidClientError("refresh token was issued to a different client");
    }
    if (token.issuer !== undefined && token.issuer !== this.config.mcpServerUrl) {
      throw new InvalidGrantError(
        "refresh token was issued by a different gojira-mcp instance",
      );
    }
  }

  private assertRefreshIndexBinding(
    index: StoredRefreshFamilyIndex,
    client: OAuthClientInformationFull,
  ): void {
    if (index.clientId !== undefined && index.clientId !== client.client_id) {
      throw new InvalidClientError("refresh token was issued to a different client");
    }
    if (index.issuer !== undefined && index.issuer !== this.config.mcpServerUrl) {
      throw new InvalidGrantError(
        "refresh token was issued by a different gojira-mcp instance",
      );
    }
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
      issuer: this.config.mcpServerUrl,
    };
    const rtVal: StoredRefreshToken = {
      accountId: opts.accountId,
      clientId: opts.clientId,
      familyId,
      generation,
      issuer: this.config.mcpServerUrl,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(GojiraOAuthProvider.keys.mcpAccess(accessToken), JSON.stringify(atVal), "EX", MCP_ACCESS_TTL);
    pipeline.set(GojiraOAuthProvider.keys.mcpRefresh(refreshToken), JSON.stringify(rtVal), "EX", MCP_REFRESH_TTL);
    pipeline.set(
      GojiraOAuthProvider.keys.rtFamilyIndex(refreshToken),
      this.serializeFamilyIndex({
        familyId,
        clientId: opts.clientId,
        issuer: this.config.mcpServerUrl,
        generation,
      }),
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

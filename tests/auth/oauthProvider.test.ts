import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { GojiraOAuthProvider } from "../../src/auth/oauthProvider.js";
import { RefreshFamily } from "../../src/auth/refreshFamily.js";
import { makeRedis } from "../helpers/redis.js";
import type { AppConfig } from "../../src/config.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

function buildConfig(mcpServerUrl = "http://localhost:8081"): AppConfig {
  return {
    nodeEnv: "test",
    logLevel: "fatal",
    mcpPort: 8081,
    mcpServerUrl,
    allowedOrigins: ["*"],
    redisUrl: "redis://mock",
    tokenEncryptionKey: randomBytes(32),
    rateLimitPerUser: 60,
    tls: null,
    atlassian: {
      clientId: "test-client",
      clientSecret: "test-secret",
      callbackUri: "http://localhost:8081/oauth/atlassian-callback",
      scopes: ["offline_access", "read:jira-work"],
      pinnedCloudId: null,
    },
    orgAdmin: { enabled: false, token: null, orgId: null },
    audit: { mainTarget: "stdout", orgAdminTarget: "stdout" },
    journal: { ttlDays: 30 },
    refreshReuseAlertWebhook: null,
    nearLimitExtraDeduct: 5,
    enabledGroups: [],
  } as unknown as AppConfig;
}

const fakeClient: OAuthClientInformationFull = {
  client_id: "client-x",
  client_secret: "client-x-secret",
  redirect_uris: ["http://localhost:9000/cb"],
  client_id_issued_at: 0,
};

function familyIdFromIndex(raw: string): string {
  return raw.startsWith("{") ? (JSON.parse(raw) as { familyId: string }).familyId : raw;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GojiraOAuthProvider — rotating refresh tokens with reuse detection", () => {
  let redis: ReturnType<typeof makeRedis>;
  let provider: GojiraOAuthProvider;
  const accountId = "abc123";
  const config = buildConfig();

  beforeEach(async () => {
    redis = makeRedis();
    provider = new GojiraOAuthProvider({ redis, config });
    await redis.set(`token:${accountId}`, "encrypted-blob");
  });

  afterEach(async () => {
    await redis.quit();
  });

  it("issues a paired AT/RT and tracks family membership", async () => {
    const tokens = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const familyIdx = await redis.get(`rt_family:${tokens.refresh_token!}`);
    expect(familyIdx).toBeTruthy();
    const parsedIndex = JSON.parse(familyIdx!) as {
      familyId: string;
      clientId: string;
      issuer: string;
      generation: number;
    };
    expect(parsedIndex).toMatchObject({
      clientId: fakeClient.client_id,
      issuer: config.mcpServerUrl,
      generation: 1,
    });

    const familyMembers = await redis.smembers(`refresh_family:${parsedIndex.familyId}`);
    expect(familyMembers).toContain(tokens.refresh_token);
  });

  it("rotates the RT on exchangeRefreshToken", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(await redis.get(`mcp_refresh:${first.refresh_token!}`)).toBeNull();
    expect(await redis.get(`rt_family:${first.refresh_token!}`)).toBeTruthy();
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeTruthy();
  });

  it("returns the exact winning pair to two concurrent refreshes", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const siblingProvider = new GojiraOAuthProvider({ redis, config });

    const [winner, duplicate] = await Promise.all([
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
      siblingProvider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ]);

    expect(duplicate).toEqual(winner);
    expect(await redis.get(`mcp_refresh:${winner.refresh_token!}`)).toBeTruthy();
    const index = await redis.get(`rt_family:${winner.refresh_token!}`);
    const members = await redis.smembers(`refresh_family:${familyIdFromIndex(index!)}`);
    expect(members).toEqual([winner.refresh_token]);
  });

  it("keeps the five-second replay receipt fixed and non-sliding", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-11T18:00:00.000Z"));
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const replayKey = `mcp_refresh_replay:${first.refresh_token!}`;
    expect(await redis.ttl(replayKey)).toBe(5);

    vi.setSystemTime(new Date("2026-08-11T18:00:03.000Z"));
    expect(await provider.exchangeRefreshToken(fakeClient, first.refresh_token!)).toEqual(second);
    expect(await redis.ttl(replayKey)).toBeLessThanOrEqual(2);

    vi.setSystemTime(new Date("2026-08-11T18:00:06.000Z"));
    await expect(
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/invalid or revoked/);
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeNull();
    expect(await redis.get(`mcp_token:${second.access_token}`)).toBeNull();
  });

  it("burns the current family when an older receipt's child has already rotated", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const third = await provider.exchangeRefreshToken(fakeClient, second.refresh_token!);

    await expect(
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/invalid or revoked/);
    expect(await redis.get(`mcp_refresh:${third.refresh_token!}`)).toBeNull();
    expect(await redis.get(`mcp_token:${third.access_token}`)).toBeNull();
  });

  it("never resurrects a family when stale reuse races the current rotation", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const firstIndex = await redis.get(`rt_family:${first.refresh_token!}`);
    const familyId = familyIdFromIndex(firstIndex!);
    await redis.del(`mcp_refresh_replay:${first.refresh_token!}`);

    const outcomes = await Promise.allSettled([
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
      provider.exchangeRefreshToken(fakeClient, second.refresh_token!),
    ]);

    expect(await redis.smembers(`refresh_family:${familyId}`)).toEqual([]);
    expect(await redis.smembers(`refresh_family_tokens:${familyId}`)).toEqual([]);
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeNull();
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        expect(await redis.get(`mcp_refresh:${outcome.value.refresh_token!}`)).toBeNull();
        expect(await redis.get(`mcp_token:${outcome.value.access_token}`)).toBeNull();
      }
    }
  });

  it("rejects a different client_id without consuming the active token", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const otherClient: OAuthClientInformationFull = { ...fakeClient, client_id: "other" };
    await expect(
      provider.exchangeRefreshToken(otherClient, first.refresh_token!),
    ).rejects.toThrow(/different client/);
    expect(await redis.get(`mcp_refresh:${first.refresh_token!}`)).toBeTruthy();
    await expect(provider.exchangeRefreshToken(fakeClient, first.refresh_token!)).resolves.toBeTruthy();
  });

  it("does not disclose a replay receipt to a different client_id", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const otherClient: OAuthClientInformationFull = { ...fakeClient, client_id: "other" };

    await expect(
      provider.exchangeRefreshToken(otherClient, first.refresh_token!),
    ).rejects.toThrow(/different client/);
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeTruthy();
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeTruthy();
  });

  it("rejects a different client after replay grace without burning the live child", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const otherClient: OAuthClientInformationFull = { ...fakeClient, client_id: "other" };
    await redis.del(`mcp_refresh_replay:${first.refresh_token!}`);

    await expect(
      provider.exchangeRefreshToken(otherClient, first.refresh_token!),
    ).rejects.toThrow(/different client/);
    await expect(provider.verifyAccessToken(second.access_token)).resolves.toBeTruthy();
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeTruthy();
  });

  it("reports stale reuse once after the atomic family burn", async () => {
    const reportReuse = vi.spyOn(RefreshFamily.prototype, "reportReuse");
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    const firstIndex = await redis.get(`rt_family:${first.refresh_token!}`);
    const familyId = familyIdFromIndex(firstIndex!);
    await redis.del(`mcp_refresh_replay:${first.refresh_token!}`);

    await expect(
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/invalid or revoked/);
    expect(reportReuse).toHaveBeenCalledOnce();
    expect(reportReuse).toHaveBeenCalledWith(
      familyId,
      {
        reason:
          "Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.",
        accountId,
        webhookUrl: null,
      },
      { refreshTokensRevoked: 1, accessTokensRevoked: 2 },
    );
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeNull();
    expect(await redis.get(`mcp_token:${second.access_token}`)).toBeNull();
  });

  it("consumes the RT without minting a successor when upstream credentials are gone", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    await redis.del(`token:${accountId}`);

    await expect(
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/upstream credential/);
    expect(await redis.get(`mcp_refresh:${first.refresh_token!}`)).toBeNull();
    expect(await redis.exists(`mcp_refresh_replay:${first.refresh_token!}`)).toBe(0);
  });

  it("verifyAccessToken returns AuthInfo with accountId in extra", async () => {
    const t = await provider.mintMcpTokens({ accountId, clientId: fakeClient.client_id });
    const info = await provider.verifyAccessToken(t.access_token);
    expect(info.extra?.accountId).toBe(accountId);
    expect(info.clientId).toBe(fakeClient.client_id);
  });
});

describe("GojiraOAuthProvider — cross-instance issuer isolation (shared Redis)", () => {
  // Two split-surface profile instances share one Redis; each mints and honors
  // only its own tokens. See docs/deployment/profiles.md.
  let redis: ReturnType<typeof makeRedis>;
  let instanceA: GojiraOAuthProvider;
  let instanceB: GojiraOAuthProvider;
  const accountId = "abc123";

  beforeEach(async () => {
    redis = makeRedis();
    instanceA = new GojiraOAuthProvider({
      redis,
      config: buildConfig("http://gojira.internal:8081"),
    });
    instanceB = new GojiraOAuthProvider({
      redis,
      config: buildConfig("http://gojira.internal:8082"),
    });
    await redis.set(`token:${accountId}`, "encrypted-blob");
  });

  afterEach(async () => {
    await redis.quit();
  });

  it("stamps the minting instance's issuer into stored AT and RT records", async () => {
    const t = await instanceA.mintMcpTokens({ accountId, clientId: fakeClient.client_id });
    const at = JSON.parse((await redis.get(`mcp_token:${t.access_token}`))!);
    const rt = JSON.parse((await redis.get(`mcp_refresh:${t.refresh_token!}`))!);
    expect(at.issuer).toBe("http://gojira.internal:8081");
    expect(rt.issuer).toBe("http://gojira.internal:8081");
  });

  it("rejects an access token minted by a sibling instance — without deleting it", async () => {
    const t = await instanceA.mintMcpTokens({ accountId, clientId: fakeClient.client_id });
    await expect(instanceB.verifyAccessToken(t.access_token)).rejects.toThrow(
      /different gojira-mcp instance/,
    );
    // Still valid at its own instance: the sibling must not have consumed it.
    const info = await instanceA.verifyAccessToken(t.access_token);
    expect(info.extra?.accountId).toBe(accountId);
  });

  it("rejects a sibling's refresh token WITHOUT consuming it or tripping reuse detection", async () => {
    const t = await instanceA.mintMcpTokens({ accountId, clientId: fakeClient.client_id });
    await expect(instanceB.exchangeRefreshToken(fakeClient, t.refresh_token!)).rejects.toThrow(
      /different gojira-mcp instance/,
    );
    // The RT record must survive the rejected exchange…
    expect(await redis.get(`mcp_refresh:${t.refresh_token!}`)).toBeTruthy();
    // …and still rotate normally at its own instance (no family revocation).
    const rotated = await instanceA.exchangeRefreshToken(fakeClient, t.refresh_token!);
    expect(rotated.refresh_token).not.toBe(t.refresh_token);
    const info = await instanceA.verifyAccessToken(rotated.access_token);
    expect(info.extra?.accountId).toBe(accountId);
  });

  it("rejects a sibling issuer during and after replay grace without burning the family", async () => {
    const first = await instanceA.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await instanceA.exchangeRefreshToken(fakeClient, first.refresh_token!);

    await expect(
      instanceB.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/different gojira-mcp instance/);
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeTruthy();

    await redis.del(`mcp_refresh_replay:${first.refresh_token!}`);
    await expect(
      instanceB.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow(/different gojira-mcp instance/);
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeTruthy();
    await expect(instanceA.verifyAccessToken(second.access_token)).resolves.toBeTruthy();
  });

  it("grandfathers pre-upgrade tokens that carry no issuer stamp", async () => {
    // Hand-write records in the pre-issuer format.
    const legacyAt = "a".repeat(64);
    const legacyRt = "b".repeat(64);
    const familyId = "legacy-family";
    await redis.set(
      `mcp_token:${legacyAt}`,
      JSON.stringify({
        accountId,
        clientId: fakeClient.client_id,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        familyId,
      }),
    );
    await redis.set(
      `mcp_refresh:${legacyRt}`,
      JSON.stringify({ accountId, clientId: fakeClient.client_id, familyId, generation: 1 }),
    );
    await redis.set(`rt_family:${legacyRt}`, familyId);

    const info = await instanceA.verifyAccessToken(legacyAt);
    expect(info.extra?.accountId).toBe(accountId);

    // Legacy RT exchanges fine, and the replacement pair is issuer-stamped.
    const minted = await instanceA.exchangeRefreshToken(fakeClient, legacyRt);
    const newRt = JSON.parse((await redis.get(`mcp_refresh:${minted.refresh_token!}`))!);
    expect(newRt.issuer).toBe("http://gojira.internal:8081");
    const newIndex = JSON.parse((await redis.get(`rt_family:${minted.refresh_token!}`))!);
    expect(newIndex).toMatchObject({
      familyId,
      clientId: fakeClient.client_id,
      issuer: "http://gojira.internal:8081",
      generation: 2,
    });
    const upgradedOldIndex = JSON.parse((await redis.get(`rt_family:${legacyRt}`))!);
    expect(upgradedOldIndex).toMatchObject({
      familyId,
      clientId: fakeClient.client_id,
      issuer: "http://gojira.internal:8081",
      generation: 1,
    });
  });

  it("rejects an unbound stale legacy index without burning its live family", async () => {
    const legacyParent = "c".repeat(64);
    const familyId = "legacy-stale-family";
    const liveChild = await instanceA.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
      familyId,
      generation: 2,
    });
    await redis.set(`rt_family:${legacyParent}`, familyId);

    await expect(
      instanceB.exchangeRefreshToken(fakeClient, legacyParent),
    ).rejects.toThrow(/invalid or revoked/);
    await expect(instanceA.verifyAccessToken(liveChild.access_token)).resolves.toBeTruthy();
    expect(await redis.get(`mcp_refresh:${liveChild.refresh_token!}`)).toBeTruthy();
  });
});

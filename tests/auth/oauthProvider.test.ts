import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { GojiraOAuthProvider } from "../../src/auth/oauthProvider.js";
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

  it("issues a paired AT/RT and tracks family membership", async () => {
    const tokens = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    expect(tokens.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    const familyIdx = await redis.get(`rt_family:${tokens.refresh_token!}`);
    expect(familyIdx).toBeTruthy();

    const familyMembers = await redis.smembers(`refresh_family:${familyIdx!}`);
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

  it("detects reuse — replaying an old RT after rotation revokes the entire family", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const second = await provider.exchangeRefreshToken(fakeClient, first.refresh_token!);
    await expect(
      provider.exchangeRefreshToken(fakeClient, first.refresh_token!),
    ).rejects.toThrow();
    expect(await redis.get(`mcp_refresh:${second.refresh_token!}`)).toBeNull();
    expect(await redis.get(`mcp_token:${second.access_token}`)).toBeNull();
  });

  it("rejects RTs presented by a different client_id", async () => {
    const first = await provider.mintMcpTokens({
      accountId,
      clientId: fakeClient.client_id,
    });
    const otherClient: OAuthClientInformationFull = { ...fakeClient, client_id: "other" };
    await expect(
      provider.exchangeRefreshToken(otherClient, first.refresh_token!),
    ).rejects.toThrow(/different client/);
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
  });
});

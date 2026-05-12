import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { GojiraOAuthProvider } from "../../src/auth/oauthProvider.js";
import { makeRedis } from "../helpers/redis.js";
import type { AppConfig } from "../../src/config.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

function buildConfig(): AppConfig {
  return {
    nodeEnv: "test",
    logLevel: "fatal",
    mcpPort: 8081,
    mcpServerUrl: "http://localhost:8081",
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

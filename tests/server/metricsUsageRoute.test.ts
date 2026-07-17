import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../../src/server.js";
import type { AppConfig } from "../../src/config.js";
import { UsageMetrics } from "../../src/metrics/usage.js";
import { makeRedis } from "../helpers/redis.js";

const METRICS_TOKEN = "metrics-secret-token-123";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return Object.freeze({
    nodeEnv: "test",
    logLevel: "error",
    mcpPort: 8081,
    mcpServerUrl: "http://localhost:8081",
    allowedOrigins: ["*"],
    redisUrl: "redis://localhost:6379",
    tokenEncryptionKey: Buffer.alloc(32, 1),
    rateLimitPerUser: 60,
    tls: null,
    atlassian: {
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUri: "http://localhost:8081/oauth/atlassian-callback",
      scopes: ["read:jira-work", "offline_access"],
      pinnedCloudId: null,
    },
    orgAdmin: { enabled: false, token: null, orgId: null, adminAccountIds: [] },
    audit: { mainTarget: "stdout", orgAdminTarget: "stdout" },
    journal: { ttlDays: 30 },
    metricsToken: METRICS_TOKEN,
    refreshReuseAlertWebhook: null,
    nearLimitExtraDeduct: 5,
    enabledGroups: ["utility"],
    ...overrides,
  } as AppConfig);
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; base: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("GET /metrics/usage", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("is not registered when metricsToken is unset", async () => {
    const app = createApp(makeConfig({ metricsToken: null }), makeRedis());
    const started = await listen(app);
    server = started.server;

    const res = await fetch(`${started.base}/metrics/usage`);
    expect(res.status).toBe(404);
  });

  it("rejects missing or wrong bearer tokens", async () => {
    const app = createApp(makeConfig(), makeRedis());
    const started = await listen(app);
    server = started.server;

    const missing = await fetch(`${started.base}/metrics/usage`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${started.base}/metrics/usage`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("returns the aggregated summary for a valid token", async () => {
    const redis = makeRedis();
    const seed = new UsageMetrics(redis);
    seed.record("projects.listJiraProjects", "acct-1", true);
    seed.record("projects.listJiraProjects", "acct-1", true);
    seed.record("issues.createJiraIssue", "acct-2", false);
    await flushAsync();

    const app = createApp(makeConfig(), redis);
    const started = await listen(app);
    server = started.server;

    const res = await fetch(`${started.base}/metrics/usage?days=1`, {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      totals: { calls: number; errors: number };
      byTool: Record<string, { calls: number; errors: number }>;
      byUser: Record<string, { calls: number; errors: number }>;
    };

    expect(body.days).toBe(1);
    expect(body.totals).toEqual({ calls: 2, errors: 1 });
    expect(body.byTool["projects.listJiraProjects"]).toEqual({ calls: 2, errors: 0 });
    expect(body.byUser["acct-2"]).toEqual({ calls: 0, errors: 1 });

    const allTime = (body as unknown as { allTime: { totals: { calls: number; errors: number } } }).allTime;
    expect(allTime.totals).toEqual({ calls: 2, errors: 1 });
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveCredentials, makeClientFactories } from "../../src/tools/wrapHandler.js";
import { defineTool } from "../../src/tools/defs/defineTool.js";
import { AuthRequiredError } from "../../src/middleware/errorHandler.js";
import type { ToolDeps } from "../../src/tools/types.js";

const makeTool = (authMethod: "oauth" | "api_token" | "oauth_or_api_token") =>
  defineTool({
    name: `t_${authMethod}`,
    description: "test",
    group: "utility",
    authMethod,
    needsCloudId: false,
    input: { x: z.string().optional() },
    handler: async () => ({}),
  });

const depsWith = (opts: { oauth?: boolean; apiToken?: boolean }): ToolDeps =>
  ({
    tokenRefresher: {
      ensureFreshToken: async () => {
        if (!opts.oauth) throw new AuthRequiredError("no oauth");
        return {
          access_token: "at",
          refresh_token: null,
          expires_at: Date.now() + 60_000,
          account_id: "acct",
          name: "n",
          email: null,
          accessible_cloud_ids: ["cloud-1"],
          primary_cloud_id: "cloud-1",
        };
      },
    },
    apiTokenStore: {
      get: async () =>
        opts.apiToken
          ? { email: "svc@example.com", token: "tok", cloud_id: "cloud-1", site_url: "x.atlassian.net" }
          : null,
    },
  } as unknown as ToolDeps);

describe("oauth_or_api_token credential resolution (revertOperation context)", () => {
  it("loads both credentials when both exist", async () => {
    const creds = await resolveCredentials(makeTool("oauth_or_api_token"), depsWith({ oauth: true, apiToken: true }), "acct");
    expect(creds.storedToken?.access_token).toBe("at");
    expect(creds.apiToken?.token).toBe("tok");
  });

  it("tolerates a missing API token (OAuth-only reverts still work)", async () => {
    const creds = await resolveCredentials(makeTool("oauth_or_api_token"), depsWith({ oauth: true }), "acct");
    expect(creds.storedToken?.access_token).toBe("at");
    expect(creds.apiToken).toBeNull();
  });

  it("tolerates missing OAuth (api-token-only reverts still work)", async () => {
    const creds = await resolveCredentials(makeTool("oauth_or_api_token"), depsWith({ apiToken: true }), "acct");
    expect(creds.storedToken).toBeNull();
    expect(creds.apiToken?.token).toBe("tok");
  });

  it("api_token mode still hard-requires the bound token", async () => {
    await expect(resolveCredentials(makeTool("api_token"), depsWith({ oauth: true }), "acct")).rejects.toThrow(
      AuthRequiredError,
    );
  });
});

describe("automation() client factory tenant guard", () => {
  const factories = (boundCloudId: string | null, resolvedCloudId: string | null) =>
    makeClientFactories({
      deps: { config: { nearLimitExtraDeduct: 0 }, rateLimiter: { applyFeedback: async () => {} } } as unknown as ToolDeps,
      accountId: "acct",
      cloudId: resolvedCloudId,
      credentials: {
        storedToken: null,
        apiToken: { email: "svc@example.com", token: "tok", cloud_id: boundCloudId, site_url: "x.atlassian.net" },
      },
    });

  it("builds the automation client when the bound token matches the resolved cloudId", () => {
    expect(() => factories("cloud-1", "cloud-1").automation()).not.toThrow();
  });

  it("fails closed when the bound token has no cloud_id but a tenant is resolved", () => {
    // bindApiToken now always stores a verified cloudId, so a null here means a
    // stale/hand-written binding — the guard must not route it past the pin.
    expect(() => factories(null, "cloud-1").automation()).toThrow(/does not match|missing/);
  });

  it("fails closed when the token is bound to a different cloudId", () => {
    expect(() => factories("cloud-2", "cloud-1").automation()).toThrow(/does not match|missing/);
  });

  it("requires a cloudId at all", () => {
    expect(() => factories("cloud-1", null).automation()).toThrow(/requires a cloudId/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { makeRedis } from "../helpers/redis.js";
import { utilityTools } from "../../src/tools/defs/utility.js";
import { ApiTokenStore } from "../../src/auth/apiTokenStore.js";
import { ValidationError } from "../../src/middleware/errorHandler.js";
import type { ToolContext } from "../../src/tools/types.js";

// bindApiToken makes two HTTP calls: GET {site}/_edge/tenant_info and
// GET {site}/rest/api/3/myself. Mock axios so we can drive both. The factory is
// hoisted above module init, so the shared fn is created via vi.hoisted.
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({ default: { get: mockGet }, get: mockGet }));

const PINNED = "cloud-A";
const KEY = Buffer.alloc(32, 9);
const ACCOUNT = "acct-1";

function bindTool() {
  const t = utilityTools().find((d) => d.name === "gojira.bindApiToken");
  if (!t) throw new Error("bindApiToken not found");
  return t;
}

function ctx(redis = makeRedis()): ToolContext {
  return {
    accountId: ACCOUNT,
    config: { atlassian: { pinnedCloudId: PINNED }, tokenEncryptionKey: KEY },
    redis,
  } as unknown as ToolContext;
}

/**
 * Route the two GETs: tenant_info returns `cloudId`; myself returns the caller's
 * accountId. `tenantInfoCloudId: null` simulates tenant_info being unreachable.
 */
function mockSite(opts: { tenantInfoCloudId: string | null; myselfAccountId?: string }) {
  mockGet.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/_edge/tenant_info")) {
      return opts.tenantInfoCloudId === null
        ? Promise.reject(new Error("network"))
        : Promise.resolve({ data: { cloudId: opts.tenantInfoCloudId } });
    }
    if (u.includes("/rest/api/3/myself")) {
      return Promise.resolve({ data: { accountId: opts.myselfAccountId ?? ACCOUNT, displayName: "T" } });
    }
    return Promise.reject(new Error(`unexpected url ${u}`));
  });
}

const INPUT = { email: "u@example.com", token: "tok12345", site_url: "acme.atlassian.net" };

describe("bindApiToken site-pin binding (site_url must belong to the pinned cloudId)", () => {
  it("binds when the site_url resolves to the pinned cloudId, storing the verified cloudId", async () => {
    mockSite({ tenantInfoCloudId: PINNED });
    const redis = makeRedis();
    const res = (await bindTool().handler(INPUT, ctx(redis))) as { bound: boolean };
    expect(res.bound).toBe(true);
    const stored = await new ApiTokenStore(redis, KEY).get(ACCOUNT);
    expect(stored?.cloud_id).toBe(PINNED); // verified, never a blind default
    expect(stored?.site_url).toBe("acme.atlassian.net");
  });

  it("REJECTS a site_url whose real cloudId differs from the pin (the bypass)", async () => {
    mockSite({ tenantInfoCloudId: "cloud-B" });
    await expect(bindTool().handler(INPUT, ctx())).rejects.toThrow(ValidationError);
  });

  it("REJECTS a supplied cloud_id that disagrees with the site_url's real cloudId", async () => {
    mockSite({ tenantInfoCloudId: PINNED });
    await expect(bindTool().handler({ ...INPUT, cloud_id: "cloud-B" }, ctx())).rejects.toThrow(ValidationError);
  });

  it("REJECTS when tenant_info can't be resolved (no silent trust of site_url)", async () => {
    mockSite({ tenantInfoCloudId: null });
    await expect(bindTool().handler(INPUT, ctx())).rejects.toThrow(ValidationError);
  });
});

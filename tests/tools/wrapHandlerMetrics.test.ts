import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/defs/defineTool.js";
import { registerWrappedTool } from "../../src/tools/wrapHandler.js";
import type { ToolDeps } from "../../src/tools/types.js";

type WrappedTool = (
  args: unknown,
  extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } },
) => Promise<{ isError?: boolean }>;

const okTool = defineTool({
  name: "test.ok",
  description: "succeeds",
  group: "utility",
  authMethod: "none",
  needsCloudId: false,
  input: { x: z.string().optional() },
  handler: async () => ({ done: true }),
});

const boomTool = defineTool({
  name: "test.boom",
  description: "fails",
  group: "utility",
  authMethod: "none",
  needsCloudId: false,
  input: { x: z.string().optional() },
  handler: async () => {
    throw new Error("boom");
  },
});

describe("registerWrappedTool usage metrics", () => {
  const record = vi.fn();
  let wrapped: Map<string, WrappedTool>;
  let deps: ToolDeps;

  const server = {
    registerTool: (name: string, _meta: unknown, cb: WrappedTool) => {
      wrapped.set(name, cb);
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    wrapped = new Map();
    deps = {
      config: { enabledGroups: ["utility"], orgAdmin: { orgId: null } },
      rateLimiter: { checkLimit: async () => ({ allowed: true }) },
      audit: { emit: () => {} },
      usageMetrics: { record },
      journal: {},
    } as unknown as ToolDeps;
    registerWrappedTool(server as never, okTool as never, deps, { clientId: "c1" });
    registerWrappedTool(server as never, boomTool as never, deps, { clientId: "c1" });
  });

  const extraFor = (accountId: string | null) => ({
    authInfo: accountId
      ? { extra: { accountId }, clientId: "c1" }
      : { extra: {}, clientId: "c1" },
  });

  it("records a successful call as ok", async () => {
    const result = await wrapped.get("test.ok")!({}, extraFor("acct-1"));

    expect(result.isError).toBeUndefined();
    expect(record).toHaveBeenCalledWith("test.ok", "acct-1", true);
  });

  it("records a failed call as not ok", async () => {
    const result = await wrapped.get("test.boom")!({}, extraFor("acct-1"));

    expect(result.isError).toBe(true);
    expect(record).toHaveBeenCalledWith("test.boom", "acct-1", false);
  });

  it("does not record calls without an authenticated accountId", async () => {
    const result = await wrapped.get("test.ok")!({}, extraFor(null));

    expect(result.isError).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });
});

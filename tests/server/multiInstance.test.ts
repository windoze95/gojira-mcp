import { describe, expect, it, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registerSessionTools } from "../../src/tools/registry.js";
import { OperationJournal } from "../../src/operations/journal.js";
import { RateLimiter } from "../../src/middleware/rateLimiter.js";
import { makeRedis } from "../helpers/redis.js";
import type { ToolDeps } from "../../src/tools/types.js";
import type { AppConfig } from "../../src/config.js";

/**
 * Two split-surface instances sharing one Redis: disjoint tool surfaces, one
 * shared journal, and reverts that only run on the instance owning the
 * original tool's group. This is the profiles-fleet contract end-to-end
 * through the real registry + wrapHandler dispatch (harness-style capture,
 * same as tests/e2e/harness.ts).
 */

const ACCOUNT_ID = "acct-1";
const CLOUD_ID = "cloud-1";

type Wrapped = (
  args: unknown,
  extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } },
) => Promise<CallToolResult>;

interface Instance {
  name: string;
  journal: OperationJournal;
  tools: Map<string, Wrapped>;
}

function buildInstance(
  redis: ReturnType<typeof makeRedis>,
  name: string,
  enabledGroups: string[],
): Instance {
  const config = {
    nodeEnv: "test",
    logLevel: "fatal",
    instanceName: name,
    mcpServerUrl: `http://gojira.internal/${name}`,
    enabledGroups,
    orgAdmin: { enabled: false, token: null, orgId: null, adminAccountIds: [] },
    atlassian: { pinnedCloudId: null, scopes: [], clientId: "c", clientSecret: "s", callbackUri: "http://x" },
    ui: { enabled: false },
    journal: { ttlDays: 30 },
    tokenEncryptionKey: randomBytes(32),
    rateLimitPerUser: 1000,
    nearLimitExtraDeduct: 5,
  } as unknown as AppConfig;

  const journal = new OperationJournal(redis, 30, name);
  const deps = {
    config,
    redis,
    rateLimiter: new RateLimiter(redis, { capacity: 1000, windowSec: 60 }),
    audit: { emit: () => {} },
    journal,
    usageMetrics: { record: () => {} },
    tokenRefresher: {
      ensureFreshToken: async () => ({
        access_token: "test-at",
        refresh_token: "test-rt",
        name: "Test User",
        email: "test@example.com",
        accessible_cloud_ids: [CLOUD_ID],
        primary_cloud_id: CLOUD_ID,
      }),
    },
    apiTokenStore: { get: async () => null },
    orgAdminVerifier: { verify: async () => {} },
  } as unknown as ToolDeps;

  const tools = new Map<string, Wrapped>();
  const fakeServer = {
    registerTool: (toolName: string, _cfg: unknown, cb: Wrapped) => {
      tools.set(toolName, cb);
    },
    registerResource: () => {},
  } as unknown as McpServer;

  registerSessionTools(fakeServer, deps, { clientId: "test-client" });
  return { name, journal, tools };
}

async function call(
  inst: Instance,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; envelope: { success: boolean; result?: unknown; error?: { message?: string; code?: string } } }> {
  const wrapped = inst.tools.get(tool);
  if (!wrapped) throw new Error(`tool ${tool} not registered on ${inst.name}`);
  const res = await wrapped(args, { authInfo: { extra: { accountId: ACCOUNT_ID }, clientId: "test-client" } });
  const envelope = res.structuredContent as {
    success: boolean;
    result?: unknown;
    error?: { message?: string; code?: string };
  };
  return { isError: res.isError === true, envelope };
}

describe("split-surface instances sharing one Redis", () => {
  let redis: ReturnType<typeof makeRedis>;
  let readonly: Instance;
  let platform: Instance;

  beforeEach(() => {
    redis = makeRedis();
    readonly = buildInstance(redis, "gojira-readonly", ["utility", "read_schemes"]);
    platform = buildInstance(redis, "gojira-platform", ["utility", "write_schemes"]);
  });

  it("registers disjoint surfaces apart from the shared utility group", () => {
    expect(readonly.tools.has("schemes.readAccess")).toBe(true);
    expect(readonly.tools.has("schemes.managePermission")).toBe(false);
    expect(platform.tools.has("schemes.managePermission")).toBe(true);
    expect(platform.tools.has("schemes.readAccess")).toBe(false);
    for (const inst of [readonly, platform]) {
      expect(inst.tools.has("gojira.health")).toBe(true);
      expect(inst.tools.has("gojira.revertOperation")).toBe(true);
    }
    const readonlyOnly = [...readonly.tools.keys()].filter((t) => !t.startsWith("gojira."));
    const platformOnly = [...platform.tools.keys()].filter((t) => !t.startsWith("gojira."));
    expect(readonlyOnly.filter((t) => platformOnly.includes(t))).toEqual([]);
  });

  it("reports its own identity through gojira.health", async () => {
    const a = await call(readonly, "gojira.health", {});
    const b = await call(platform, "gojira.health", {});
    expect((a.envelope.result as { instance: string }).instance).toBe("gojira-readonly");
    expect((b.envelope.result as { instance: string }).instance).toBe("gojira-platform");
  });

  it("shares the journal for reading but gates reverts on the owning group", async () => {
    // The platform instance journals a successful, revertible write — under
    // the PRE-COLLAPSE tool name, deliberately: this doubles as the live
    // cross-instance test of the legacy alias path (old entries must keep
    // resolving through schemes.managePermission#createPermissionScheme).
    const args = {
      accountId: ACCOUNT_ID,
      tool: "schemes.createPermissionScheme",
      cloudId: CLOUD_ID,
      target: { kind: "permission_scheme", id: "10001" },
      before: null,
      request: { name: "Test scheme" },
      revertible: true,
    };
    const opId = await platform.journal.begin(args);
    await platform.journal.complete(opId, { ...args, after: { id: "10001" }, outcome: "success" });

    // Visible from the readonly instance (shared journal is a feature)…
    const listed = await call(readonly, "gojira.listRecentOperations", {});
    const entries = (listed.envelope.result as { entries: Array<{ op_id: string }> }).entries;
    expect(entries.map((e) => e.op_id)).toContain(opId);

    // …with the owning instance stamped on the entry.
    const got = await call(readonly, "gojira.getOperation", { op_id: opId });
    expect((got.envelope.result as { instance: string }).instance).toBe("gojira-platform");

    // But the readonly instance may not execute (or even dry-run) the revert.
    const denied = await call(readonly, "gojira.revertOperation", { op_id: opId, commit: true });
    expect(denied.isError).toBe(true);
    expect(denied.envelope.error?.message).toMatch(/requires group 'write_schemes'/);
    expect(denied.envelope.error?.message).toMatch(/instance 'gojira-platform'/);

    const deniedDry = await call(readonly, "gojira.revertOperation", { op_id: opId });
    expect(deniedDry.isError).toBe(true);

    // The owning instance passes the gate — dry run renders the revert diff.
    const dry = await call(platform, "gojira.revertOperation", { op_id: opId });
    expect(dry.isError).toBe(false);
    const dryResult = dry.envelope.result as { dry_run: boolean; original: { op_id: string } };
    expect(dryResult.dry_run).toBe(true);
    expect(dryResult.original.op_id).toBe(opId);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { loadConfig, resetConfigForTests } from "../../src/config.js";

/**
 * loadConfig() reads process.env, caches, and process.exit(1)s on invalid
 * config. Each test builds its env from scratch; exit is stubbed to throw so
 * the failure path is assertable.
 */

const MANAGED_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "MCP_PORT",
  "MCP_SERVER_URL",
  "ALLOWED_ORIGINS",
  "REDIS_URL",
  "TOKEN_ENCRYPTION_KEY",
  "ATLASSIAN_OAUTH_CLIENT_ID",
  "ATLASSIAN_OAUTH_CLIENT_SECRET",
  "ATLASSIAN_OAUTH_SCOPES",
  "ATLASSIAN_CALLBACK_URI",
  "ATLASSIAN_PINNED_CLOUD_ID",
  "GOJIRA_ENABLE_ORG_ADMIN",
  "GOJIRA_ORG_ADMIN_TOKEN",
  "GOJIRA_ORG_ID",
  "GOJIRA_ORG_ADMIN_ACCOUNT_IDS",
  "GOJIRA_REFRESH_REUSE_POLICY",
  "GOJIRA_ENABLED_GROUPS",
  "GOJIRA_INSTANCE_NAME",
] as const;

const BASE_ENV: Record<string, string> = {
  NODE_ENV: "test",
  ALLOWED_ORIGINS: "*",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  ATLASSIAN_OAUTH_CLIENT_ID: "test-client",
  ATLASSIAN_OAUTH_CLIENT_SECRET: "test-secret",
  ATLASSIAN_OAUTH_SCOPES: "offline_access read:me",
  GOJIRA_ENABLED_GROUPS: "utility",
};

class ExitCalled extends Error {
  constructor(readonly code: unknown) {
    super(`process.exit(${String(code)})`);
  }
}

describe("loadConfig", () => {
  let saved: Record<string, string | undefined>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = {};
    for (const k of MANAGED_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    resetConfigForTests();
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of MANAGED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigForTests();
    vi.restoreAllMocks();
  });

  const loggedErrors = (): string => errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");

  it("defaults GOJIRA_INSTANCE_NAME to 'gojira-mcp'", () => {
    const cfg = loadConfig();
    expect(cfg.instanceName).toBe("gojira-mcp");
    expect(cfg.enabledGroups).toEqual(["utility"]);
  });

  it("accepts a profile-style instance name", () => {
    process.env.GOJIRA_INSTANCE_NAME = "gojira-readonly";
    const cfg = loadConfig();
    expect(cfg.instanceName).toBe("gojira-readonly");
  });

  it("defaults refresh reuse handling to strict", () => {
    expect(loadConfig().refreshReusePolicy).toBe("strict");
  });

  it("accepts containment refresh reuse handling", () => {
    process.env.GOJIRA_REFRESH_REUSE_POLICY = "contain";
    expect(loadConfig().refreshReusePolicy).toBe("contain");
  });

  it("rejects an unknown refresh reuse policy", () => {
    process.env.GOJIRA_REFRESH_REUSE_POLICY = "ignore";
    expect(() => loadConfig()).toThrow(ExitCalled);
    expect(loggedErrors()).toContain("GOJIRA_REFRESH_REUSE_POLICY");
  });

  it("rejects instance names outside the allowed charset", () => {
    process.env.GOJIRA_INSTANCE_NAME = "bad name!";
    expect(() => loadConfig()).toThrow(ExitCalled);
    expect(loggedErrors()).toContain("GOJIRA_INSTANCE_NAME");
  });

  it("rejects instance names with a leading separator", () => {
    process.env.GOJIRA_INSTANCE_NAME = "-gojira";
    expect(() => loadConfig()).toThrow(ExitCalled);
  });

  it("rejects unknown permission groups, naming the valid ones", () => {
    process.env.GOJIRA_ENABLED_GROUPS = "utility,read_schemes,not_a_group";
    expect(() => loadConfig()).toThrow(ExitCalled);
    const logged = loggedErrors();
    expect(logged).toContain("not_a_group");
    expect(logged).toContain("Valid groups");
  });

  it("rejects an empty group allowlist", () => {
    process.env.GOJIRA_ENABLED_GROUPS = " , ,";
    expect(() => loadConfig()).toThrow(ExitCalled);
    expect(loggedErrors()).toContain("at least one permission group");
  });

  it("parses and trims a full multi-group allowlist", () => {
    process.env.GOJIRA_ENABLED_GROUPS = "utility, read_schemes , write_schemes";
    const cfg = loadConfig();
    expect(cfg.enabledGroups).toEqual(["utility", "read_schemes", "write_schemes"]);
  });
});

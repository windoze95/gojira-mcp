/**
 * E2E battle-test harness.
 *
 * Drives the REAL tool pipeline — registerWrappedTool's full wrapping
 * (group gate, rate limit, credential resolution, cloudId pinning, client
 * factories, journaling, error mapping) with real HTTP against a live
 * Atlassian tenant. Only two boundaries are substituted, both fed from env:
 *   - tokenRefresher: returns the E2E OAuth access token (or throws
 *     AuthRequiredError when none is configured)
 *   - apiTokenStore: returns the E2E API token binding
 * Redis is ioredis-mock (the journal/rate-limiter on top are the real
 * implementations), so runs are hermetic and leave no server state behind.
 *
 * Credentials come from env (see .env.e2e.example): E2E_SITE_URL,
 * E2E_CLOUD_ID, E2E_EMAIL, E2E_API_TOKEN, and optionally
 * E2E_OAUTH_ACCESS_TOKEN for the OAuth-path suites.
 *
 * Every suite MUST leave the tenant clean (create → verify → delete).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeRedis } from "../helpers/redis.js";
import { loadConfig } from "../../src/config.js";
import type { AppConfig } from "../../src/config.js";
import { OperationJournal } from "../../src/operations/journal.js";
import { RateLimiter } from "../../src/middleware/rateLimiter.js";
import { AuthRequiredError } from "../../src/middleware/errorHandler.js";
import { registerWrappedTool } from "../../src/tools/wrapHandler.js";
import { allTools } from "../../src/tools/defs/index.js";
import type { ToolDeps } from "../../src/tools/types.js";
import type { AuditSink } from "../../src/utils/audit.js";
import type { ApiTokenStore } from "../../src/auth/apiTokenStore.js";
import type { TokenRefresher } from "../../src/auth/tokenRefresh.js";
import type { OrgAdminVerifier } from "../../src/auth/orgAdminVerifier.js";

export interface E2ECreds {
  siteUrl: string; // e.g. example-site.atlassian.net (no scheme)
  cloudId: string;
  email: string;
  apiToken: string;
  oauthAccessToken: string | null;
  accountId: string;
}

export function e2eCreds(): E2ECreds | null {
  const { E2E_SITE_URL, E2E_CLOUD_ID, E2E_EMAIL, E2E_API_TOKEN, E2E_OAUTH_ACCESS_TOKEN, E2E_ACCOUNT_ID } = process.env;
  if (!E2E_SITE_URL || !E2E_CLOUD_ID || !E2E_EMAIL || !E2E_API_TOKEN) return null;
  return {
    siteUrl: E2E_SITE_URL.replace(/^https?:\/\//, ""),
    cloudId: E2E_CLOUD_ID,
    email: E2E_EMAIL,
    apiToken: E2E_API_TOKEN,
    oauthAccessToken: E2E_OAUTH_ACCESS_TOKEN ?? null,
    accountId: E2E_ACCOUNT_ID ?? "e2e-account",
  };
}

/** vitest describe.skipIf helper — truthy when the e2e env is absent. */
export const noCreds = e2eCreds() === null;

type WrappedTool = (
  args: unknown,
  extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } },
) => Promise<CallToolResult>;

export interface E2EHarness {
  /** Call a tool through the full wrapped pipeline. Throws on isError results. */
  call<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Same, but returns the raw envelope without throwing. */
  callRaw(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: unknown }>;
  config: AppConfig;
  deps: ToolDeps;
}

function e2eConfig(creds: E2ECreds): AppConfig {
  // loadConfig() reads (and caches from) process.env — seed the required keys
  // before the first call so validation + defaults stay the real code path.
  const seed: Record<string, string> = {
    NODE_ENV: "test",
    ATLASSIAN_OAUTH_CLIENT_ID: "e2e-client",
    ATLASSIAN_OAUTH_CLIENT_SECRET: "e2e-secret",
    ATLASSIAN_OAUTH_SCOPES: "offline_access read:me read:jira-work",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    MCP_SERVER_URL: "http://localhost:0",
    ALLOWED_ORIGINS: "http://localhost:0",
    ATLASSIAN_PINNED_CLOUD_ID: creds.cloudId,
    GOJIRA_ENABLED_GROUPS:
      "utility,read_jsm_admin,write_jsm_admin,read_automation,write_automation," +
      "read_confluence_admin,write_confluence_admin,read_assets,write_assets," +
      "read_projects,write_projects,read_schemes,write_schemes,read_workflows," +
      "write_workflows,read_customfields,write_customfields,read_agile,write_agile," +
      "read_filters_dashboards,write_filters_dashboards",
  };
  for (const [k, val] of Object.entries(seed)) {
    if (process.env[k] === undefined || process.env[k] === "") process.env[k] = val;
  }
  return loadConfig();
}

export function buildHarness(): E2EHarness {
  const creds = e2eCreds();
  if (!creds) throw new Error("E2E env missing — see .env.e2e.example");

  const config = e2eConfig(creds);
  const redis = makeRedis();
  const journal = new OperationJournal(redis, config.journal.ttlDays);
  const rateLimiter = new RateLimiter(redis, { capacity: 10_000, windowSec: 60 });

  const audit = {
    emit: () => {},
  } as unknown as AuditSink;

  const tokenRefresher = {
    ensureFreshToken: async () => {
      if (!creds.oauthAccessToken) {
        throw new AuthRequiredError("No E2E OAuth token configured (set E2E_OAUTH_ACCESS_TOKEN)");
      }
      return {
        access_token: creds.oauthAccessToken,
        refresh_token: null,
        expires_at: Date.now() + 3600_000,
        account_id: creds.accountId,
        name: "e2e",
        email: creds.email,
        accessible_cloud_ids: [creds.cloudId],
        primary_cloud_id: creds.cloudId,
      };
    },
  } as unknown as TokenRefresher;

  const apiTokenStore = {
    get: async () => ({
      account_id: creds.accountId,
      email: creds.email,
      token: creds.apiToken,
      cloud_id: creds.cloudId,
      site_url: creds.siteUrl,
      display_name: "e2e",
      added_at: 0,
    }),
  } as unknown as ApiTokenStore;

  const orgAdminVerifier = {
    verify: async () => {
      throw new AuthRequiredError("org-admin not exercised in e2e");
    },
  } as unknown as OrgAdminVerifier;

  const deps: ToolDeps = {
    config,
    redis,
    rateLimiter,
    audit,
    journal,
    tokenRefresher,
    apiTokenStore,
    orgAdminVerifier,
  };

  // Capture wrapped callables through a fake McpServer.
  const wrapped = new Map<string, WrappedTool>();
  const fakeServer = {
    registerTool: (name: string, _meta: unknown, cb: WrappedTool) => {
      wrapped.set(name, cb);
    },
  };
  for (const def of allTools()) {
    registerWrappedTool(fakeServer as never, def as never, deps, { clientId: "e2e" });
  }

  const extra = { authInfo: { extra: { accountId: creds.accountId }, clientId: "e2e" } };

  const callRaw = async (name: string, args: Record<string, unknown>) => {
    const fn = wrapped.get(name);
    if (!fn) throw new Error(`Tool not registered: ${name}`);
    const res = await fn(args, extra);
    const text = res.content?.find((c) => c.type === "text") as { text?: string } | undefined;
    let body: unknown = text?.text;
    try {
      body = JSON.parse(text?.text ?? "null");
    } catch {
      /* leave as string */
    }
    return { isError: res.isError === true, body };
  };

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { isError, body } = await callRaw(name, args);
    if (isError) {
      throw new Error(`${name} failed: ${JSON.stringify(body).slice(0, 500)}`);
    }
    // Success envelopes wrap the handler return as { success: true, result }.
    const env = body as { success?: boolean; result?: unknown };
    return (env && env.success === true && "result" in env ? env.result : body) as T;
  };

  return { call, callRaw, config, deps };
}

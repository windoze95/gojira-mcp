import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { ToolContext, ToolDefinition, ToolDeps } from "./types.js";
import {
  AtlassianClient,
  jiraBase,
  confluenceBase,
  adminBase,
  assetsBase,
  automationBase,
  formsBase,
} from "../atlassian/client.js";
import { AtlassianApiError, mapAtlassianError } from "../atlassian/errors.js";
import { ApiTokenStore } from "../auth/apiTokenStore.js";
import {
  AuthRequiredError,
  InsufficientPermissionsError,
  RateLimitedError,
  ToolError,
  handleToolError,
} from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";
import type { JournalEntry } from "../operations/journal.js";

/**
 * Registers a single tool against an MCP server, wrapping the handler in all
 * the cross-cutting concerns: authn, rate limit, operator-floor enforcement,
 * cloudId pinning, journal, audit, error normalization.
 *
 * Accepts the loose `AnyToolDef` shape because that's what the registry stores.
 * The runtime cast to `ZodObject` is safe because every defineTool() call wraps
 * input in `z.object`.
 */
export function registerWrappedTool(
  server: McpServer,
  def: ToolDefinition<z.ZodTypeAny, unknown>,
  deps: ToolDeps,
  opts: { clientId: string },
): void {
  const schemaAsObject = def.inputSchema as unknown as z.ZodObject<z.ZodRawShape>;
  const shape = schemaAsObject.shape;
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: shape,
    },
    async (args: unknown, extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } }) => {
      const start = Date.now();
      const operationId = randomUUID();
      // Tracks the cloudId once resolved so a failure after resolution still
      // audits the real target (not null).
      let resolvedCloudId: string | null = null;
      // Correlates journal opIds with this call's audit operation_id. The first
      // journaled mutation reuses operationId; extras get a deterministic suffix.
      let journalSeq = 0;
      const authInfo = extra.authInfo;
      const accountId =
        (authInfo?.extra && typeof authInfo.extra.accountId === "string"
          ? (authInfo.extra.accountId as string)
          : null) ?? null;
      const clientId = authInfo?.clientId ?? opts.clientId ?? "unknown";

      const sendAudit = (
        outcome: "success" | "failure" | "dry_run",
        errorCode: string | null,
        request: Record<string, unknown>,
        cloudId: string | null,
      ): void => {
        deps.audit.emit(
          {
            ts: new Date().toISOString(),
            level: "audit",
            event: "tool_call",
            actor: {
              account_id: accountId ?? "(unknown)",
              name: null,
              email: null,
            },
            tool: def.name,
            group: def.group,
            cloud_id: cloudId,
            client_id: clientId,
            request,
            outcome,
            error_code: errorCode,
            duration_ms: Date.now() - start,
            operation_id: operationId,
            ...(def.group === "admin_org"
              ? { org_id: deps.config.orgAdmin.orgId ?? null }
              : {}),
          },
          { orgAdmin: def.group === "admin_org" },
        );
      };

      const fail = (err: unknown, request: Record<string, unknown>, cloudId: string | null): CallToolResult => {
        const envelope = handleToolError(err);
        sendAudit("failure", envelope.error.code, request, cloudId);
        return toolResult(envelope, true);
      };

      try {
        if (!accountId) throw new AuthRequiredError("Bearer token did not carry an account identifier");

        // Operator-allowlist enforcement at dispatch time (defense in depth —
        // the registry filter already excluded out-of-allowlist tools at
        // registration).
        if (!deps.config.enabledGroups.includes(def.group)) {
          throw new InsufficientPermissionsError(
            `Tool '${def.name}' is in group '${def.group}', which is not enabled on this deployment`,
          );
        }
        if (def.group === "admin_org") {
          if (!deps.config.orgAdmin.enabled) {
            throw new InsufficientPermissionsError("Org admin tools are not enabled on this instance");
          }
          await deps.orgAdminVerifier.verify(accountId);
        }

        // Rate limit.
        const limit = await deps.rateLimiter.checkLimit(accountId);
        if (!limit.allowed) {
          throw new RateLimitedError("Rate limit exceeded; slow down.", {
            soft_capped: limit.softCapped,
            tokens: limit.tokens,
          });
        }

        // Resolve credentials + cloudId.
        const credentials = await resolveCredentials(def, deps, accountId);
        const cloudId = resolveCloudId(def, deps.config, credentials);
        resolvedCloudId = cloudId;

        // Build per-call client factories.
        const clientFactories = makeClientFactories({
          deps,
          accountId,
          cloudId,
          credentials,
        });

        const ctx: ToolContext = {
          accountId,
          user: {
            accountId,
            name: credentials.storedToken?.name ?? credentials.apiToken?.display_name ?? null,
            email: credentials.storedToken?.email ?? credentials.apiToken?.email ?? null,
          },
          cloudId,
          storedToken: credentials.storedToken,
          apiToken: credentials.apiToken,
          client: clientFactories,
          journal: deps.journal,
          audit: deps.audit,
          config: deps.config,
          log: logger,
          rateLimiter: deps.rateLimiter,
          redis: deps.redis,
          defaultJournalArgs: {
            accountId,
            tool: def.name,
            cloudId,
          },
          async journalOp(jArgs) {
            const correlatedId = journalSeq === 0 ? operationId : `${operationId}.${journalSeq}`;
            journalSeq += 1;
            const opId = await deps.journal.begin(jArgs, correlatedId);
            let outcome: "success" | "failure" = "success";
            let error: { code: string; message: string } | undefined;
            let after: unknown = null;
            try {
              after = await jArgs.run();
            } catch (e) {
              outcome = "failure";
              const code =
                e instanceof ToolError ? e.code : "UNEXPECTED_ERROR";
              const message = e instanceof Error ? e.message : String(e);
              error = { code, message };
              const entry = await deps.journal.complete(opId, {
                ...jArgs,
                after,
                outcome,
                error,
              });
              // Bubble the original error after journaling.
              (e as Error & { journalEntry?: JournalEntry }).journalEntry = entry;
              throw e;
            }
            // Persist any created id onto the target so revert can find it.
            const target =
              jArgs.deriveTargetId && jArgs.deriveTargetId(after)
                ? { ...jArgs.target, id: jArgs.deriveTargetId(after) as string }
                : jArgs.target;
            return deps.journal.complete(opId, {
              ...jArgs,
              target,
              after,
              outcome,
              revertible: jArgs.revertible ?? false,
            });
          },
        };

        const parsed = schemaAsObject.parse(args ?? {});
        let result: unknown;
        try {
          result = await def.handler(parsed, ctx);
        } catch (err) {
          if (err instanceof AtlassianApiError) {
            throw mapAtlassianError(err, { adminOrg: def.group === "admin_org" });
          }
          throw err;
        }

        const outcome: "success" | "dry_run" =
          isDryRunResult(result) ? "dry_run" : "success";
        sendAudit(outcome, null, sanitizeRequest(parsed), cloudId);
        return toolResult({ success: true, result }, false);
      } catch (err) {
        const requestForAudit = sanitizeRequest(args);
        return fail(err, requestForAudit, resolvedCloudId);
      }
    },
  );
}

function isDryRunResult(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && (v as { dry_run?: unknown }).dry_run === true);
}

function sanitizeRequest(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (/token|secret|password/i.test(k)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}

function toolResult(payload: unknown, isError: boolean): CallToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
  };
}

interface ResolvedCredentials {
  storedToken: import("../auth/tokenStore.js").StoredToken | null;
  apiToken: import("../auth/apiTokenStore.js").StoredApiToken | null;
}

async function resolveCredentials(
  def: ToolDefinition<z.ZodTypeAny, unknown>,
  deps: ToolDeps,
  accountId: string,
): Promise<ResolvedCredentials> {
  let storedToken: ResolvedCredentials["storedToken"] = null;
  let apiToken: ResolvedCredentials["apiToken"] = null;

  if (def.authMethod === "oauth" || def.authMethod === "api_token" || def.authMethod === "oauth_or_api_token") {
    try {
      storedToken = await deps.tokenRefresher.ensureFreshToken(accountId);
    } catch (err) {
      if (def.authMethod === "oauth") throw err;
      // For api_token tools we still want to know who the caller is, but missing
      // OAuth shouldn't block them. Silently continue with no storedToken.
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), accountId },
        "OAuth missing for api_token tool — continuing without OAuth context",
      );
    }
  }

  if (def.authMethod === "api_token" || def.authMethod === "oauth_or_api_token") {
    apiToken = await deps.apiTokenStore.get(accountId);
    if (!apiToken && def.authMethod === "api_token") {
      throw new AuthRequiredError(
        "This tool requires a per-user Atlassian API token to be bound first.",
        { auth_method: "api_token", bind_tool: "gojira.bindApiToken" },
      );
    }
  }

  return { storedToken, apiToken };
}

function resolveCloudId(
  def: ToolDefinition<z.ZodTypeAny, unknown>,
  config: import("../config.js").AppConfig,
  creds: ResolvedCredentials,
): string | null {
  if (!def.needsCloudId) return null;
  const pinned = config.atlassian.pinnedCloudId;
  const fromOAuth = creds.storedToken?.primary_cloud_id ?? null;
  const fromApi = creds.apiToken?.cloud_id ?? null;
  const cloudId = pinned ?? fromOAuth ?? fromApi;
  if (!cloudId) {
    throw new ToolError(
      "VALIDATION_ERROR",
      "No cloudId could be resolved for this call. Re-authenticate or bind an API token with a cloud_id.",
    );
  }
  // D4 — site pinning enforcement: refuse any call whose target cloudId
  // doesn't match the pinned value.
  if (pinned) {
    const accessible = new Set<string>([
      ...(creds.storedToken?.accessible_cloud_ids ?? []),
    ]);
    if (creds.apiToken?.cloud_id) accessible.add(creds.apiToken.cloud_id);
    if (!accessible.has(pinned)) {
      throw new InsufficientPermissionsError(
        "Pinned cloudId is not accessible to this caller.",
        { pinned, accessible: [...accessible] },
      );
    }
    if (creds.apiToken && creds.apiToken.cloud_id && creds.apiToken.cloud_id !== pinned) {
      throw new InsufficientPermissionsError(
        "API token is bound to a different cloudId than this instance allows.",
        { pinned, api_token_cloud_id: creds.apiToken.cloud_id },
      );
    }
  }
  return cloudId;
}

function makeClientFactories(opts: {
  deps: ToolDeps;
  accountId: string;
  cloudId: string | null;
  credentials: ResolvedCredentials;
}): ToolContext["client"] {
  const { deps, accountId, cloudId, credentials } = opts;

  const oauthBearer = (): string => {
    const t = credentials.storedToken?.access_token;
    if (!t) throw new AuthRequiredError("OAuth credential required but not present");
    return t;
  };

  // For api-token clients whose base URL embeds the cloudId (automation, forms):
  // require a resolved cloudId, and fail closed when the bound token belongs to
  // a different site — API tokens are account-global, so on an unpinned
  // deployment the call would otherwise silently hit the wrong tenant.
  const requireApiTokenTenant = (): string => {
    if (!cloudId) throw new ToolError("VALIDATION_ERROR", "Tool requires a cloudId");
    const boundCloudId = credentials.apiToken?.cloud_id ?? null;
    if (boundCloudId && boundCloudId !== cloudId) {
      throw new ToolError(
        "VALIDATION_ERROR",
        "The bound API token belongs to a different cloudId than this call resolves to. Re-bind the token for this site or pin the cloudId.",
      );
    }
    return cloudId;
  };

  const apiTokenAuth = (): { email: string; token: string } => {
    const a = credentials.apiToken;
    if (!a) throw new AuthRequiredError("API token required but not bound", { bind_tool: "gojira.bindApiToken" });
    return { email: a.email, token: a.token };
  };

  const orgAdminBearer = (): string => {
    const t = deps.config.orgAdmin.token;
    if (!t) throw new InsufficientPermissionsError("Org admin token not configured");
    return t;
  };

  const onCallMeta = async (meta: { nearLimit: boolean; rateLimitResetUnix: number | null }, url: string) => {
    if (!meta.nearLimit && !meta.rateLimitResetUnix) return;
    const extraDeduct = meta.nearLimit ? deps.config.nearLimitExtraDeduct : 0;
    await deps.rateLimiter.applyFeedback(accountId, {
      extraDeduct,
      resetFloorUntilUnix: meta.rateLimitResetUnix ?? null,
    });
    if (meta.nearLimit) {
      logger.debug({ url, accountId, extraDeduct }, "Atlassian NearLimit — deducted extra tokens");
    }
  };

  return {
    jira: () => {
      if (!cloudId) throw new ToolError("VALIDATION_ERROR", "Tool requires a cloudId");
      return new AtlassianClient({
        baseURL: jiraBase(cloudId),
        auth: { bearer: oauthBearer() },
        onCallMeta,
      });
    },
    confluence: () => {
      if (!cloudId) throw new ToolError("VALIDATION_ERROR", "Tool requires a cloudId");
      return new AtlassianClient({
        baseURL: confluenceBase(cloudId),
        auth: { bearer: oauthBearer() },
        onCallMeta,
      });
    },
    apiTokenJira: () => {
      const t = apiTokenAuth();
      const site = credentials.apiToken?.site_url ?? null;
      if (!site) {
        throw new ToolError(
          "VALIDATION_ERROR",
          "API token is not bound to a known site URL. Re-bind via gojira.bindApiToken with site discovery succeeding.",
        );
      }
      return new AtlassianClient({
        baseURL: `https://${site}`,
        auth: { apiToken: t },
        onCallMeta,
      });
    },
    admin: () => {
      // Admin uses the org-admin token; verifier already gated the call.
      return new AtlassianClient({
        baseURL: adminBase(),
        auth: { bearer: orgAdminBearer() },
        onCallMeta,
      });
    },
    assets: (workspaceId: string) => {
      // Assets accepts OAuth bearer; some endpoints also accept API token. Default
      // to OAuth here; tools that need API token can call apiTokenJira() instead.
      return new AtlassianClient({
        baseURL: assetsBase(workspaceId),
        auth: { bearer: oauthBearer() },
        onCallMeta,
      });
    },
    automation: () => {
      // The GA Automation Rule Management API is on the api.atlassian.com host but
      // authenticates with the per-user API token via **Basic auth** (email:token)
      // — verified live: Basic → 200/400, the same token as a Bearer → 403, and
      // OAuth 3LO → 401 (no automation scope exists). The token's account must
      // be a Jira administrator (ADMINISTER global permission).
      return new AtlassianClient({
        baseURL: automationBase(requireApiTokenTenant()),
        auth: { apiToken: apiTokenAuth() },
        onCallMeta,
      });
    },
    forms: () => {
      // Jira Forms (ProForma) — Basic-auth host, verified live with the
      // per-user API token (full template lifecycle 200s).
      return new AtlassianClient({
        baseURL: formsBase(requireApiTokenTenant()),
        auth: { apiToken: apiTokenAuth() },
        onCallMeta,
      });
    },
  };
}

// Helper exposed for tests.
export { resolveCredentials, resolveCloudId, makeClientFactories, ApiTokenStore };

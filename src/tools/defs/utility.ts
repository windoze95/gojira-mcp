import axios from "axios";
import { z } from "zod";
import type { AnyToolDef } from "./defineTool.js";
import { defineTool } from "./defineTool.js";
import { ApiTokenStore } from "../../auth/apiTokenStore.js";
import { reverters, assertRevertible } from "../../operations/revert.js";
import { ValidationError, NotFoundError } from "../../middleware/errorHandler.js";

export const utilityTools = (): AnyToolDef[] => [
  defineTool({
    name: "gojira.health",
    description: "Returns server liveness, Redis ping, and OAuth issuer URL.",
    group: "utility",
    authMethod: "none",
    needsCloudId: false,
    handler: async (_input, ctx) => {
      const start = Date.now();
      let redis: "ok" | "fail" = "ok";
      try {
        const ping = await ctx.redis.ping();
        if (ping !== "PONG") redis = "fail";
      } catch {
        redis = "fail";
      }
      return {
        status: redis === "ok" ? "ok" : "degraded",
        redis,
        oauth_issuer: ctx.config.mcpServerUrl,
        pinned_cloud_id: ctx.config.atlassian.pinnedCloudId,
        enabled_groups: ctx.config.enabledGroups,
        org_admin_enabled: ctx.config.orgAdmin.enabled,
        duration_ms: Date.now() - start,
        ts: new Date().toISOString(),
      };
    },
  }),

  defineTool({
    name: "gojira.whoami",
    description:
      "Returns the caller's identity, accessible cloudIds, pinned cloudId, deployment surface info, and bound-API-token presence.",
    group: "utility",
    authMethod: "oauth",
    needsCloudId: false,
    handler: async (_input, ctx) => {
      return {
        account_id: ctx.accountId,
        name: ctx.user.name,
        email: ctx.user.email,
        accessible_cloud_ids: ctx.storedToken?.accessible_cloud_ids ?? [],
        primary_cloud_id: ctx.storedToken?.primary_cloud_id ?? null,
        pinned_cloud_id: ctx.config.atlassian.pinnedCloudId,
        enabled_groups: ctx.config.enabledGroups,
        bound_api_token: !!ctx.apiToken,
        org_admin_enabled: ctx.config.orgAdmin.enabled,
      };
    },
  }),

  defineTool({
    name: "gojira.bindApiToken",
    description:
      "Bind a per-user Atlassian API token for tools that don't accept OAuth (JSM admin, some Bitbucket). Validated via /rest/api/3/myself, stored encrypted at rest.",
    group: "utility",
    authMethod: "oauth",
    needsCloudId: false,
    input: {
      email: z.string().email().describe("The Atlassian account email used as Basic-auth username."),
      token: z.string().min(8).describe("An Atlassian API token generated at id.atlassian.com."),
      site_url: z
        .string()
        .regex(/^[a-z0-9-]+\.atlassian\.(net|com)$/i)
        .describe("Bare site host, e.g. 'acme.atlassian.net' — used as REST base."),
      cloud_id: z.string().optional(),
    },
    handler: async (input, ctx) => {
      if (
        ctx.config.atlassian.pinnedCloudId &&
        input.cloud_id &&
        input.cloud_id !== ctx.config.atlassian.pinnedCloudId
      ) {
        throw new ValidationError(
          "API token cloud_id does not match this instance's pinned cloudId.",
          { pinned: ctx.config.atlassian.pinnedCloudId, supplied: input.cloud_id },
        );
      }
      const auth = Buffer.from(`${input.email}:${input.token}`, "utf8").toString("base64");
      let body;
      try {
        const resp = await axios.get<{
          accountId: string;
          displayName: string;
          emailAddress?: string;
        }>(`https://${input.site_url}/rest/api/3/myself`, {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          timeout: 15_000,
        });
        body = resp.data;
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 401 || status === 403) {
          throw new ValidationError("Atlassian rejected the API token credential.", { status });
        }
        throw err;
      }
      if (body.accountId !== ctx.accountId) {
        throw new ValidationError(
          "Bound credential's accountId does not match the OAuth-authenticated caller.",
          { oauth_account_id: ctx.accountId, token_account_id: body.accountId },
        );
      }
      const store = new ApiTokenStore(ctx.redis, ctx.config.tokenEncryptionKey);
      await store.put({
        account_id: ctx.accountId,
        email: input.email,
        token: input.token,
        cloud_id: input.cloud_id ?? ctx.config.atlassian.pinnedCloudId ?? null,
        site_url: input.site_url,
        display_name: body.displayName,
        added_at: Date.now(),
      });
      return {
        bound: true,
        account_id: ctx.accountId,
        display_name: body.displayName,
        cloud_id: input.cloud_id ?? ctx.config.atlassian.pinnedCloudId ?? null,
        site_url: input.site_url,
      };
    },
  }),

  defineTool({
    name: "gojira.listEnabledTools",
    description:
      "Lists the tools available to this caller, given the deployment's operator allowlist and org-admin gate.",
    group: "utility",
    authMethod: "none",
    needsCloudId: false,
    handler: async (_input, ctx) => {
      // Lazy import to avoid a circular cycle between defs/index and utility.
      const { allTools } = await import("./index.js");
      const tools = allTools();
      const result: Array<{
        name: string;
        group: string;
        auth_method: string;
        destructive: boolean;
        available: boolean;
        reason?: string;
      }> = [];
      const enabledSet = new Set(ctx.config.enabledGroups);
      for (const t of tools) {
        let available = true;
        let reason: string | undefined;
        if (!enabledSet.has(t.group)) {
          available = false;
          reason = `group '${t.group}' is not enabled on this deployment`;
        } else if (t.group === "admin_org" && !ctx.config.orgAdmin.enabled) {
          available = false;
          reason = "org admin disabled on this instance";
        } else if (t.authMethod === "api_token" && !ctx.apiToken) {
          available = false;
          reason = "requires a bound API token (call gojira.bindApiToken)";
        }
        result.push({
          name: t.name,
          group: t.group,
          auth_method: t.authMethod,
          destructive: t.destructive,
          available,
          ...(reason ? { reason } : {}),
        });
      }
      // Aggregate by group for client UIs that want to render grouped lists.
      const byGroup: Record<string, string[]> = {};
      for (const t of result) {
        if (!byGroup[t.group]) byGroup[t.group] = [];
        byGroup[t.group].push(t.name);
      }
      return {
        deployment: {
          org_admin_enabled: ctx.config.orgAdmin.enabled,
          pinned_cloud_id: ctx.config.atlassian.pinnedCloudId,
          enabled_groups: ctx.config.enabledGroups,
        },
        caller: { has_api_token: !!ctx.apiToken },
        by_group: byGroup,
        tools: result,
      };
    },
  }),

  defineTool({
    name: "gojira.listRecentOperations",
    description: "List the caller's recent operations from the journal. 30-day rolling window by default.",
    group: "utility",
    authMethod: "oauth",
    needsCloudId: false,
    input: {
      limit: z.number().int().positive().max(200).default(25).optional(),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
    },
    handler: async (input, ctx) => {
      const sinceMs = input.since ? Date.parse(input.since) : undefined;
      const untilMs = input.until ? Date.parse(input.until) : undefined;
      const entries = await ctx.journal.list(ctx.accountId, {
        limit: input.limit ?? 25,
        sinceUnixMs: sinceMs,
        untilUnixMs: untilMs,
      });
      return {
        count: entries.length,
        entries: entries.map((e) => ({
          op_id: e.opId,
          tool: e.tool,
          target: e.target,
          completed_at: e.completedAt,
          outcome: e.outcome,
          revertible: e.revertible,
          error_code: e.errorCode ?? null,
        })),
      };
    },
  }),

  defineTool({
    name: "gojira.getOperation",
    description: "Retrieve a single journal entry by opId, including before/after snapshots.",
    group: "utility",
    authMethod: "oauth",
    needsCloudId: false,
    input: { op_id: z.string().uuid() },
    handler: async (input, ctx) => {
      const entry = await ctx.journal.get(ctx.accountId, input.op_id);
      if (!entry) throw new NotFoundError(`No journal entry found for opId ${input.op_id}`);
      return entry;
    },
  }),

  defineTool({
    name: "gojira.revertOperation",
    description:
      "Reverts a previously-journaled operation (where mechanically possible). Logs the revert itself as a new journal entry. Use `commit: true` to apply.",
    group: "utility",
    authMethod: "oauth",
    needsCloudId: false,
    destructive: true,
    input: { op_id: z.string().uuid(), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const entry = await ctx.journal.get(ctx.accountId, input.op_id);
      if (!entry) throw new NotFoundError(`No journal entry for opId ${input.op_id}`);
      assertRevertible(entry);
      if (input.commit !== true) {
        return {
          dry_run: true,
          message: `Would revert operation ${entry.opId} (${entry.tool}). Re-invoke with commit:true to apply.`,
          original: {
            tool: entry.tool,
            target: entry.target,
            before: entry.before,
            after: entry.after,
          },
        };
      }
      const reverter = reverters.resolve(entry.tool);
      if (!reverter) {
        throw new ValidationError(`No reverter registered for tool '${entry.tool}'.`);
      }
      const result = await reverter(entry, ctx);
      return { reverted: true, result, original_op_id: entry.opId };
    },
  }),
];

import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Jira Cloud Automation rules, via the Automation public REST API:
 *   api.atlassian.com/automation/public/jira/{cloudId}/rest/v1/rule...
 * (ctx.client.automation()). The previous code used /rest/cb-automation, which
 * is a Jira Data Center internal path that does not exist on Cloud.
 *
 * IMPORTANT — scope caveat: the Automation public API requires the automation
 * OAuth scope, which is NOT offered to standard 3LO OAuth apps (there is no
 * Automation entry in the developer-console scope list, and a classic-scope
 * token gets 401 "scope does not match"). It generally requires a Connect/Forge
 * app credential. These endpoints could NOT be live-verified here; if your
 * deployment's credential cannot reach the automation API, DISABLE this group by
 * removing read_automation/write_automation from GOJIRA_ENABLED_GROUPS.
 */
const BASE = "";

export const automationTools = (): AnyToolDef[] => [
  defineTool({
    name: "automation.listAutomationRules",
    description: "List Jira automation rules. Either project-scoped (projectKey) or global.",
    group: "read_automation",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      projectKey: z.string().optional(),
      query: z.string().optional(),
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams();
      p.set("startAt", String(input.startAt ?? 0));
      p.set("maxResults", String(input.maxResults ?? 50));
      if (input.query) p.set("query", input.query);
      if (input.projectKey) p.set("projectId", input.projectKey);
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/rule?${p.toString()}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "automation.getAutomationRule",
    description: "Retrieve a single automation rule by id.",
    group: "read_automation",
    authMethod: "oauth",
    needsCloudId: true,
    input: { ruleId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "automation.createAutomationRule",
    description:
      "Create a new automation rule. Provide the rule body as Atlassian's JSON shape. Destructive — requires `commit:true`.",
    group: "write_automation",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      projectKey: z.string().optional(),
      rule: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.createAutomationRule",
        target: { kind: "automation_rule", name: (input.rule as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: input.rule,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.createAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", name: (input.rule as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { projectKey: input.projectKey, rule: input.rule } as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the rule by id.",
        deriveTargetId: (after) => (after as { id?: string })?.id,
        run: async () => {
          const resp = await ctx.client.automation().post<{ id: string }>(`${BASE}/rule`, input.rule);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, rule: entry.after };
    },
  }),

  defineTool({
    name: "automation.updateAutomationRule",
    description: "Replace a rule body in place. Captures full-before/full-after diff.",
    group: "write_automation",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      ruleId: z.string().min(1),
      rule: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const before = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.updateAutomationRule",
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        after: input.rule,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.updateAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        request: { ruleId: input.ruleId, rule: input.rule } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before` payload back to the same rule id.",
        run: async () => {
          const resp = await ctx.client.automation().put<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`, input.rule);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "automation.deleteAutomationRule",
    description: "Delete an automation rule. **Irreversible.**",
    group: "write_automation",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { ruleId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const before = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "automation.deleteAutomationRule",
          target: { kind: "automation_rule", id: input.ruleId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.deleteAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        request: { ruleId: input.ruleId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await ctx.client.automation().delete<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
          return { deleted: input.ruleId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "automation.enableAutomationRule",
    description: "Enable a rule. Revertible (disable).",
    group: "write_automation",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { ruleId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const before = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.enableAutomationRule",
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        after: { ...(before.data as object), state: "ENABLED" },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.enableAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        request: { ruleId: input.ruleId } as Record<string, unknown>,
        revertible: true,
        revertHint: "Call disableAutomationRule on the same id.",
        run: async () => {
          const resp = await ctx.client.automation().post<unknown>(
            `${BASE}/rule/${encodeURIComponent(input.ruleId)}/enable`,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "automation.disableAutomationRule",
    description: "Disable a rule. Revertible (enable).",
    group: "write_automation",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { ruleId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const before = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.disableAutomationRule",
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        after: { ...(before.data as object), state: "DISABLED" },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.disableAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        request: { ruleId: input.ruleId } as Record<string, unknown>,
        revertible: true,
        revertHint: "Call enableAutomationRule on the same id.",
        run: async () => {
          const resp = await ctx.client.automation().post<unknown>(
            `${BASE}/rule/${encodeURIComponent(input.ruleId)}/disable`,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "automation.getAutomationRuleAuditLog",
    description: "Returns recent audit-log entries for a single automation rule.",
    group: "read_automation",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      ruleId: z.string().min(1),
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.automation().get<unknown>(
        `${BASE}/rule/${encodeURIComponent(input.ruleId)}/audit-log?${p.toString()}`,
      );
      return resp.data;
    },
  }),

  defineTool({
    name: "automation.getAutomationUsage",
    description: "Returns automation usage statistics for this site (executions, queue depth).",
    group: "read_automation",
    authMethod: "oauth",
    needsCloudId: true,
    handler: async (_input, ctx) => {
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/usage`);
      return resp.data;
    },
  }),
];

reverters.register("automation.createAutomationRule", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: created rule id missing.");
  await ctx.client.automation().delete<unknown>(`${BASE}/rule/${encodeURIComponent(id)}`);
  return { deleted: id };
});

reverters.register("automation.disableAutomationRule", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: rule id missing.");
  const resp = await ctx.client.automation().post<unknown>(`${BASE}/rule/${encodeURIComponent(id)}/enable`);
  return { enabled: id, response: resp.data };
});

reverters.register("automation.enableAutomationRule", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: rule id missing.");
  const resp = await ctx.client.automation().post<unknown>(`${BASE}/rule/${encodeURIComponent(id)}/disable`);
  return { disabled: id, response: resp.data };
});

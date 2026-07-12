import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Jira Cloud Automation rules ("business rules"), via the GA Automation Rule
 * Management REST API:
 *   https://api.atlassian.com/automation/public/jira/{cloudId}/rest/v1/...
 * (ctx.client.automation()). The old code targeted /rest/cb-automation, a Jira
 * Data Center internal path absent on Cloud.
 *
 * AUTH (verified live): this API is on the api.atlassian.com host but
 * authenticates with the per-user API token via **Basic auth** (email:token) —
 * the same `api_token` mode gojira's JSM tools use. Confirmed against the dev
 * tenant: Basic → 200 (list) / 400 (write validation), whereas the same token as
 * a Bearer → 403, and OAuth 3LO → 401 (no automation scope exists). One
 * requirement: the token's account must be a **Jira administrator** (holds the
 * ADMINISTER global permission) — otherwise every call returns 403.
 * Endpoints below are the real ones from the Automation OpenAPI spec, and every
 * one of them was exercised live (create 201 / list / get / state / delete /
 * templates). Two contract details the spec hides:
 *   - `PUT /rule/{uuid}/state` takes `{ value: "ENABLED"|"DISABLED" }` — the
 *     key is `value`, not `state` (a `{state}` body gets 400 "could not be
 *     parsed").
 *   - `DELETE /rule/{uuid}` 400s ("Rule cannot be deleted unless it is already
 *     disabled") on an ENABLED rule — delete tools disable first.
 * To author a rule payload, the practical path is: create from a template
 * (`createRuleFromTemplate`) or in the UI, export it with `getAutomationRule`,
 * and use that shape — the spec's component `value` shapes are undocumented.
 */
const BASE = "";

export const automationTools = (): AnyToolDef[] => [
  defineTool({
    name: "automation.listAutomationRules",
    description: "List automation rules (summaries) for this site.",
    group: "read_automation",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({ limit: String(input.limit ?? 50) });
      if (input.cursor) p.set("cursor", input.cursor);
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/rule/summary?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "automation.getAutomationRule",
    description: "Retrieve a single automation rule by its UUID.",
    group: "read_automation",
    authMethod: "api_token",
    needsCloudId: true,
    input: { ruleId: z.string().min(1).describe("The rule UUID.") },
    handler: async (input, ctx) => {
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "automation.searchManualRules",
    description: "Find manually-triggerable automation rules available for a given object (e.g. an issue).",
    group: "read_automation",
    authMethod: "api_token",
    needsCloudId: true,
    input: { payload: z.record(z.string(), z.unknown()).describe("The rule/manual/search request body.") },
    handler: async (input, ctx) => {
      const resp = await ctx.client.automation().post<unknown>(`${BASE}/rule/manual/search`, input.payload);
      return resp.data;
    },
  }),
  defineTool({
    name: "automation.searchAutomationTemplates",
    description:
      "Search the catalog of automation rule templates (paginated). Pass `{}` for all, or filter by " +
      "`categories`/`home`, or continue with `cursor`. Templates are the easiest way to author a valid rule.",
    group: "read_automation",
    authMethod: "api_token",
    needsCloudId: true,
    input: { payload: z.record(z.string(), z.unknown()).default({}).optional() },
    handler: async (input, ctx) => {
      const resp = await ctx.client.automation().post<unknown>(`${BASE}/template/search`, input.payload ?? {});
      return resp.data;
    },
  }),
  defineTool({
    name: "automation.getAutomationTemplate",
    description: "Get an automation rule template by id (description, categories, required parameters).",
    group: "read_automation",
    authMethod: "api_token",
    needsCloudId: true,
    input: { templateId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.automation().get<unknown>(`${BASE}/template/${encodeURIComponent(input.templateId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "automation.createRuleFromTemplate",
    description:
      "Create an automation rule from a template. `ruleHome` is the scope ARI, e.g. " +
      "`ari:cloud:jira:{cloudId}:project/{projectId}`. Some templates require `parameters`; templates that " +
      "reference an external connection (e.g. Confluence) fail unless that connection exists. The created rule " +
      "can then be exported with getAutomationRule and adapted. Destructive — requires `commit:true`.",
    group: "write_automation",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      templateId: z.string().min(1),
      ruleHome: z.string().min(1).describe("Scope ARI the rule is created under."),
      parameters: z.record(z.string(), z.unknown()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body: Record<string, unknown> = { templateId: input.templateId, ruleHome: input.ruleHome };
      if (input.parameters) body.parameters = input.parameters;
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.createRuleFromTemplate",
        target: { kind: "automation_rule", name: `template:${input.templateId}` },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.createRuleFromTemplate",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", name: `template:${input.templateId}` },
        before: null,
        request: body,
        revertible: true,
        revertHint: "Disable, then DELETE the created rule by its UUID.",
        deriveTargetId: (after) => (after as { ruleUuid?: string })?.ruleUuid,
        run: async () => {
          // Live response: 200 { ruleId, ruleUuid }.
          const resp = await ctx.client.automation().post<{ ruleUuid?: string }>(`${BASE}/template/create`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, rule: entry.after };
    },
  }),

  defineTool({
    name: "automation.createAutomationRule",
    description:
      "Create an automation rule. `rule` is the rule object (components: trigger, conditions, actions) — the API " +
      "wraps it as { rule: <rule> }. Destructive — requires `commit:true`.",
    group: "write_automation",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      rule: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { rule: input.rule };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.createAutomationRule",
        target: { kind: "automation_rule", name: (input.rule as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.createAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", name: (input.rule as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { rule: (input.rule as { name?: string }).name } as Record<string, unknown>,
        revertible: true,
        revertHint: "Disable, then DELETE the rule by its UUID.",
        // Live response shape is { ruleUuid } (201); older shapes may use id.
        deriveTargetId: (after) => (after as { ruleUuid?: string })?.ruleUuid ?? (after as { id?: string })?.id,
        run: async () => {
          const resp = await ctx.client.automation().post<{ ruleUuid?: string }>(`${BASE}/rule`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, rule: entry.after };
    },
  }),
  defineTool({
    name: "automation.updateAutomationRule",
    description: "Replace a rule in place by UUID. Captures full before/after (rule JSON does not patch cleanly).",
    group: "write_automation",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      ruleId: z.string().min(1).describe("The rule UUID."),
      rule: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const before = await ctx.client.automation().get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
      const body = { rule: input.rule };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "automation.updateAutomationRule",
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "automation.updateAutomationRule",
        cloudId: ctx.cloudId,
        target: { kind: "automation_rule", id: input.ruleId },
        before: before.data,
        request: { ruleId: input.ruleId } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before` rule back to the same UUID.",
        run: async () => {
          const resp = await ctx.client.automation().put<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "automation.deleteAutomationRule",
    description:
      "Delete an automation rule by UUID. Disables the rule first (the API rejects deleting an enabled rule). " +
      "**Irreversible** — the full rule config is captured in the journal `before` for manual re-creation.",
    group: "write_automation",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: { ruleId: z.string().min(1).describe("The rule UUID."), commit: z.boolean().optional() },
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
          // The API 400s on deleting an ENABLED rule — disable first.
          await ctx.client
            .automation()
            .put<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}/state`, { value: "DISABLED" });
          await ctx.client.automation().delete<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}`);
          return { deleted: input.ruleId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  // Enable/disable is a state change: PUT /rule/{uuid}/state { value: ENABLED|DISABLED }
  // (verified live — the body key is `value`, not `state`).
  ...(["ENABLED", "DISABLED"] as const).map((target) => {
    const verb = target === "ENABLED" ? "enable" : "disable";
    const inverse = target === "ENABLED" ? "disable" : "enable";
    return defineTool({
      name: `automation.${verb}AutomationRule`,
      description: `${verb[0].toUpperCase() + verb.slice(1)} an automation rule by UUID. Revertible (${inverse}).`,
      group: "write_automation",
      authMethod: "api_token",
      needsCloudId: true,
      destructive: true,
      input: { ruleId: z.string().min(1).describe("The rule UUID."), commit: z.boolean().optional() },
      handler: async (input, ctx) => {
        const body = { value: target };
        const dry = buildDryRunIfNotCommitted(input, {
          tool: `automation.${verb}AutomationRule`,
          target: { kind: "automation_rule", id: input.ruleId },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          accountId: ctx.accountId,
          tool: `automation.${verb}AutomationRule`,
          cloudId: ctx.cloudId,
          target: { kind: "automation_rule", id: input.ruleId },
          before: null,
          request: { ruleId: input.ruleId, state: target } as Record<string, unknown>,
          revertible: true,
          revertHint: `Call automation.${inverse}AutomationRule on the same UUID.`,
          run: async () => {
            const resp = await ctx.client
              .automation()
              .put<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}/state`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    });
  }),
];

// Reverting a create = disable (deletes of ENABLED rules 400) then delete.
for (const name of ["automation.createAutomationRule", "automation.createRuleFromTemplate"]) {
  reverters.register(name, async (entry, anyCtx) => {
    const ctx = anyCtx as import("../types.js").ToolContext;
    const id = (entry.target as { id?: string }).id;
    if (!id) throw new Error("Cannot revert: created rule UUID missing.");
    await ctx.client.automation().put<unknown>(`/rule/${encodeURIComponent(id)}/state`, { value: "DISABLED" });
    await ctx.client.automation().delete<unknown>(`/rule/${encodeURIComponent(id)}`);
    return { deleted: id };
  });
}

// Reverting an update = PUT the captured `before` back. GET /rule/{uuid} returns
// the { rule: {...} } wrapper, which is exactly the PUT body shape.
reverters.register("automation.updateAutomationRule", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: rule UUID missing.");
  const before = entry.before as { rule?: Record<string, unknown> } | null;
  if (!before?.rule) throw new Error("Cannot revert: journal entry has no captured `before` rule.");
  const resp = await ctx.client.automation().put<unknown>(`/rule/${encodeURIComponent(id)}`, { rule: before.rule });
  return { reverted: id, response: resp.data };
});

for (const [name, value] of [
  ["automation.enableAutomationRule", "DISABLED"],
  ["automation.disableAutomationRule", "ENABLED"],
] as const) {
  reverters.register(name, async (entry, anyCtx) => {
    const ctx = anyCtx as import("../types.js").ToolContext;
    const id = (entry.target as { id?: string }).id;
    if (!id) throw new Error("Cannot revert: rule UUID missing.");
    const resp = await ctx.client.automation().put<unknown>(`/rule/${encodeURIComponent(id)}/state`, { value });
    return { reverted: id, state: value, response: resp.data };
  });
}

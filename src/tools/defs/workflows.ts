import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import type { ToolContext } from "../types.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Workflow tools, targeting Jira Cloud's current workflow API.
 *
 * Atlassian replaced the old `/rest/api/3/workflow*` surface (create/update/
 * publish/transition endpoints) with the async bulk API:
 *   GET  /rest/api/3/workflows/search   — list/search (transitions+statuses inline)
 *   POST /rest/api/3/workflows          — bulk read by name/id
 *   POST /rest/api/3/workflows/create   — create (scope + statuses + workflows)
 *   POST /rest/api/3/workflows/update   — update (statuses + workflows[{id,...}])
 *   DELETE /rest/api/3/workflow/{entityId}
 * There is no REST API for editing individual transitions or draft publishing a
 * single workflow — transition changes round-trip through /workflows/update, and
 * draft publish is a workflow-SCHEME operation.
 */
const API = "/rest/api/3";

interface WorkflowRead {
  id?: string;
  name?: string;
  transitions?: Array<Record<string, unknown> & { id?: string }>;
  [k: string]: unknown;
}

/** Read one workflow by name or entity id via the bulk read endpoint. */
async function readWorkflow(ctx: ToolContext, key: string): Promise<WorkflowRead | null> {
  const resp = await ctx.client.jira().post<{ workflows?: WorkflowRead[] }>(`${API}/workflows`, {
    workflowNames: [key],
  });
  let list = resp.data.workflows ?? [];
  if (list.length === 0) {
    // Fall back to treating the key as an entity id.
    const byId = await ctx.client.jira().post<{ workflows?: WorkflowRead[] }>(`${API}/workflows`, {
      workflowIds: [{ entityId: key }],
    });
    list = byId.data.workflows ?? [];
  }
  return list[0] ?? null;
}

export const workflowTools = (): AnyToolDef[] => [
  defineTool({
    name: "workflows.listWorkflows",
    description: "List/search workflows. Each result includes its statuses and transitions inline.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(50).default(50).optional(),
      queryString: z.string().optional().describe("Case-insensitive substring match on workflow name."),
      expand: z
        .enum(["usage", "values.transitions"])
        .optional()
        .describe("Optional expansion (usage counts, or extra transition detail)."),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      if (input.queryString) p.set("queryString", input.queryString);
      if (input.expand) p.set("expand", input.expand);
      const resp = await ctx.client.jira().get<unknown>(`${API}/workflows/search?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.getWorkflow",
    description: "Get a single workflow (with statuses + transitions) by name or entity id.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1).describe("Workflow name or entity id.") },
    handler: async (input, ctx) => {
      const wf = await readWorkflow(ctx, input.workflowId);
      if (!wf) return { found: false, workflowId: input.workflowId };
      return wf;
    },
  }),
  defineTool({
    name: "workflows.getWorkflowTransitions",
    description: "List the transitions of a workflow (each with its conditions, validators and post-functions).",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1) },
    handler: async (input, ctx) => {
      const wf = await readWorkflow(ctx, input.workflowId);
      return { workflowId: input.workflowId, transitions: wf?.transitions ?? [] };
    },
  }),
  // Conditions / validators / post-functions are transition rules carried inline
  // on each transition in the current API — no separate sub-resource endpoint.
  ...(["conditions", "validators", "actions"] as const).map((ruleField) => {
    const label = ruleField === "actions" ? "PostFunctions" : ruleField[0].toUpperCase() + ruleField.slice(1);
    return defineTool({
      name: `workflows.getWorkflow${label}`,
      description: `Get the ${ruleField === "actions" ? "post-functions" : ruleField} for a workflow transition.`,
      group: "read_workflows",
      authMethod: "oauth",
      needsCloudId: true,
      input: { workflowId: z.string().min(1), transitionId: z.string().min(1) },
      handler: async (input, ctx) => {
        const wf = await readWorkflow(ctx, input.workflowId);
        const transition = (wf?.transitions ?? []).find((t) => String(t.id) === String(input.transitionId));
        if (!transition) return { found: false, transitionId: input.transitionId };
        return { transitionId: input.transitionId, [ruleField]: transition[ruleField] ?? [] };
      },
    });
  }),

  defineTool({
    name: "workflows.createWorkflow",
    description:
      "Create one or more workflows via the bulk create API. `payload` is the POST /workflows/create body: " +
      "{ scope: { type: 'GLOBAL' | 'PROJECT', project? }, statuses: [{ statusReference, name, statusCategory }], " +
      "workflows: [{ name, description?, statuses: [...], transitions: [...] }] }. Use workflows.validateCreate first if unsure.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      payload: z
        .object({
          scope: z.record(z.string(), z.unknown()),
          statuses: z.array(z.record(z.string(), z.unknown())),
          workflows: z.array(z.record(z.string(), z.unknown())).min(1),
        })
        .passthrough(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const names = (input.payload.workflows as Array<{ name?: string }>).map((w) => w.name).filter(Boolean);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.createWorkflow",
        target: { kind: "workflow", name: names.join(", ") },
        before: null,
        after: input.payload,
        includeFullState: true,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.createWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", name: names.join(", ") },
        before: null,
        request: { workflows: names } as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created workflow(s) by entity id.",
        deriveTargetId: (after) => {
          const ws = (after as { workflows?: Array<{ id?: string }> })?.workflows ?? [];
          const ids = ws.map((w) => w.id).filter(Boolean);
          return ids.length > 0 ? ids.join(",") : undefined;
        },
        run: async () => {
          const resp = await ctx.client.jira().post<{ workflows?: Array<{ id?: string }> }>(
            `${API}/workflows/create`,
            input.payload,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, created: entry.after };
    },
  }),
  defineTool({
    name: "workflows.validateCreateWorkflow",
    description: "Dry-run validation for a create-workflow payload (no changes). Body shape matches workflows.createWorkflow.payload.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { payload: z.record(z.string(), z.unknown()) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().post<unknown>(`${API}/workflows/create/validation`, input.payload);
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.updateWorkflow",
    description:
      "Update one or more workflows via the bulk update API. `payload` is the POST /workflows/update body: " +
      "{ statuses: [...], workflows: [{ id, statuses, transitions, ... }] }. This is how transition, condition, " +
      "validator and post-function changes are applied — Jira Cloud has no per-transition REST endpoint.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      payload: z
        .object({
          statuses: z.array(z.record(z.string(), z.unknown())).optional(),
          workflows: z.array(z.record(z.string(), z.unknown())).min(1),
        })
        .passthrough(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ids = (input.payload.workflows as Array<{ id?: string }>).map((w) => w.id).filter(Boolean);
      // Capture before-state for each targeted workflow so the change is revertible.
      const before: Record<string, unknown> = {};
      for (const id of ids) before[id as string] = await readWorkflow(ctx, id as string);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.updateWorkflow",
        target: { kind: "workflow", id: ids.join(",") },
        before,
        after: input.payload,
        includeFullState: true,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.updateWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", id: ids.join(",") },
        before,
        request: { workflows: ids } as Record<string, unknown>,
        revertible: false,
        revertHint: "Re-apply the captured `before` workflow definitions via workflows.updateWorkflow.",
        run: async () => {
          const resp = await ctx.client.jira().post<unknown>(`${API}/workflows/update`, input.payload);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, result: entry.after };
    },
  }),
  defineTool({
    name: "workflows.deleteWorkflow",
    description: "Delete a workflow by name or entity id. Irreversible. The workflow must not be in use by any scheme.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { workflowId: z.string().min(1).describe("Workflow name or entity id."), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const wf = await readWorkflow(ctx, input.workflowId);
      const entityId = wf?.id ?? input.workflowId;
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "workflows.deleteWorkflow",
          target: { kind: "workflow", id: entityId },
          before: wf,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.deleteWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", id: entityId },
        before: wf,
        request: { workflowId: input.workflowId, entityId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`${API}/workflow/${encodeURIComponent(entityId)}`);
          return { deleted: entityId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "workflows.publishWorkflowSchemeDraft",
    description:
      "Publish a workflow SCHEME's draft (this is how workflow changes go live in Jira Cloud — there is no per-workflow " +
      "publish). Async: returns a task id which is polled briefly. `statusMappings` maps old→new statuses for in-flight issues.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      schemeId: z.string().min(1).describe("Workflow scheme id (see GET /rest/api/3/workflowscheme)."),
      statusMappings: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { statusMappings: input.statusMappings ?? [] };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.publishWorkflowSchemeDraft",
        target: { kind: "workflow_scheme_publish", id: input.schemeId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const c = ctx.client.jira();
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.publishWorkflowSchemeDraft",
        cloudId: ctx.cloudId,
        target: { kind: "workflow_scheme_publish", id: input.schemeId },
        before: null,
        request: { schemeId: input.schemeId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          // Returns 303 See Other with a Location to the async task.
          const startResp = await c.post<{ taskId?: string }>(
            `${API}/workflowscheme/${encodeURIComponent(input.schemeId)}/draft/publish`,
            body,
          );
          const taskId = startResp.data?.taskId;
          if (!taskId) return startResp.data ?? { status: "SUBMITTED" };
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const status = await c.get<{ status?: string }>(`${API}/task/${encodeURIComponent(taskId)}`);
            const s = status.data.status;
            if (s === "COMPLETE" || s === "FAILED" || s === "CANCELLED") return status.data;
          }
          return { status: "RUNNING", taskId, note: "Publish still in progress; poll /task/{id}." };
        },
      });
      return { ok: true, journal_id: entry.opId, result: entry.after };
    },
  }),
];

reverters.register("workflows.createWorkflow", async (entry, anyCtx) => {
  const ctx = anyCtx as ToolContext;
  const ids = String((entry.target as { id?: string }).id ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error("Cannot revert: created workflow entity id(s) missing from target.");
  const deleted: string[] = [];
  for (const id of ids) {
    await ctx.client.jira().delete<unknown>(`/rest/api/3/workflow/${encodeURIComponent(id)}`);
    deleted.push(id);
  }
  return { deleted };
});

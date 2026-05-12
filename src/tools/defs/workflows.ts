import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Workflow tools. Atlassian's workflow APIs are async with draft/published
 * states. We expose the surface; the publish handler does brief polling.
 */
const API = "/rest/api/3";

export const workflowTools = (): AnyToolDef[] => [
  defineTool({
    name: "workflows.listWorkflows",
    description: "List workflows.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
      workflowName: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      if (input.workflowName) p.set("workflowName", input.workflowName);
      const resp = await ctx.client.jira().get<unknown>(`${API}/workflow/search?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.getWorkflow",
    description: "Get a single workflow by id or name.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${API}/workflow/search?workflowName=${encodeURIComponent(input.workflowId)}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "workflows.createWorkflow",
    description: "Create a workflow definition.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      statuses: z.array(z.record(z.string(), z.unknown())).optional(),
      transitions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        name: input.name,
        description: input.description,
        statuses: input.statuses ?? [],
        transitions: input.transitions ?? [],
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.createWorkflow",
        target: { kind: "workflow", name: input.name },
        before: null,
        after: body,
        includeFullState: true,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.createWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created workflow.",
        run: async () => {
          const resp = await ctx.client.jira().post<{ id: { name?: string } }>(`${API}/workflow`, body);
          return resp.data;
        },
      });
      const created = entry.after as { id?: { name?: string } };
      if (created?.id?.name) entry.target = { ...entry.target, id: created.id.name };
      return { ok: true, journal_id: entry.opId, workflow: created };
    },
  }),
  defineTool({
    name: "workflows.updateWorkflow",
    description: "Update a workflow in-place. Captures full-before/full-after diff because workflow JSON does not patch cleanly.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      workflowId: z.string().min(1),
      body: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/workflow/search?workflowName=${encodeURIComponent(input.workflowId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.updateWorkflow",
        target: { kind: "workflow", id: input.workflowId },
        before: before.data,
        after: input.body,
        includeFullState: true,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.updateWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", id: input.workflowId },
        before: before.data,
        request: { body: "[redacted-large]" } as Record<string, unknown>,
        revertible: true,
        revertHint: "Re-PUT the captured `before` workflow body.",
        run: async () => {
          const resp = await c.put<unknown>(`${API}/workflow/${encodeURIComponent(input.workflowId)}`, input.body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "workflows.deleteWorkflow",
    description: "Delete a workflow. Irreversible.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { workflowId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/workflow/search?workflowName=${encodeURIComponent(input.workflowId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "workflows.deleteWorkflow",
          target: { kind: "workflow", id: input.workflowId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.deleteWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow", id: input.workflowId },
        before: before.data,
        request: { workflowId: input.workflowId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`${API}/workflow/${encodeURIComponent(input.workflowId)}`);
          return { deleted: input.workflowId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "workflows.getWorkflowTransitions",
    description: "List transitions in a workflow.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(
        `${API}/workflow/search?workflowName=${encodeURIComponent(input.workflowId)}&expand=transitions`,
      );
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.addWorkflowTransition",
    description: "Add a transition to a workflow's draft. Publish via publishWorkflow.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      workflowId: z.string().min(1),
      transition: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.addWorkflowTransition",
        target: { kind: "workflow_transition", parent: input.workflowId },
        before: null,
        after: input.transition,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.addWorkflowTransition",
        cloudId: ctx.cloudId,
        target: { kind: "workflow_transition", parent: input.workflowId },
        before: null,
        request: { transition: input.transition } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client.jira().post<unknown>(
            `${API}/workflow/${encodeURIComponent(input.workflowId)}/transitions`,
            input.transition,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "workflows.removeWorkflowTransition",
    description: "Remove a transition from a workflow's draft.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      workflowId: z.string().min(1),
      transitionId: z.string().min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "workflows.removeWorkflowTransition",
          target: { kind: "workflow_transition", id: input.transitionId, parent: input.workflowId },
          before: { transitionId: input.transitionId, workflowId: input.workflowId },
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.removeWorkflowTransition",
        cloudId: ctx.cloudId,
        target: { kind: "workflow_transition", id: input.transitionId, parent: input.workflowId },
        before: { transitionId: input.transitionId, workflowId: input.workflowId },
        request: { workflowId: input.workflowId, transitionId: input.transitionId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await ctx.client
            .jira()
            .delete<unknown>(
              `${API}/workflow/${encodeURIComponent(input.workflowId)}/transitions/${encodeURIComponent(input.transitionId)}`,
            );
          return { removed: input.transitionId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "workflows.getWorkflowConditions",
    description: "Get the conditions for a workflow transition.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1), transitionId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(
        `${API}/workflow/${encodeURIComponent(input.workflowId)}/transitions/${encodeURIComponent(input.transitionId)}/conditions`,
      );
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.getWorkflowPostFunctions",
    description: "Get the post-functions for a workflow transition.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1), transitionId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(
        `${API}/workflow/${encodeURIComponent(input.workflowId)}/transitions/${encodeURIComponent(input.transitionId)}/postfunctions`,
      );
      return resp.data;
    },
  }),
  defineTool({
    name: "workflows.getWorkflowValidators",
    description: "Get the validators for a workflow transition.",
    group: "read_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    input: { workflowId: z.string().min(1), transitionId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(
        `${API}/workflow/${encodeURIComponent(input.workflowId)}/transitions/${encodeURIComponent(input.transitionId)}/validators`,
      );
      return resp.data;
    },
  }),

  defineTool({
    name: "workflows.publishWorkflow",
    description:
      "Publish a workflow draft. Async — Atlassian returns an operation id; this tool polls it briefly and returns the eventual status.",
    group: "write_workflows",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      workflowId: z.string().min(1),
      statusMappings: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe("Old-status → new-status mappings for in-flight issues."),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { statusMappings: input.statusMappings ?? [] };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "workflows.publishWorkflow",
        target: { kind: "workflow_publish", id: input.workflowId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const c = ctx.client.jira();
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "workflows.publishWorkflow",
        cloudId: ctx.cloudId,
        target: { kind: "workflow_publish", id: input.workflowId },
        before: null,
        request: { workflowId: input.workflowId, statusMappings: input.statusMappings } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const startResp = await c.post<{ taskId?: string }>(
            `${API}/workflow/${encodeURIComponent(input.workflowId)}/publish`,
            body,
          );
          const taskId = startResp.data.taskId;
          if (!taskId) return startResp.data;
          // Poll: up to 10 attempts at 1.5s = 15s max.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            const status = await c.get<{ status?: string; progress?: number; result?: unknown }>(
              `${API}/task/${encodeURIComponent(taskId)}`,
            );
            const s = status.data.status;
            if (s === "COMPLETE" || s === "FAILED" || s === "CANCELLED") {
              return status.data;
            }
          }
          return { status: "RUNNING", taskId, note: "Publish still in progress; check /task/{id} for completion." };
        },
      });
      return { ok: true, journal_id: entry.opId, result: entry.after };
    },
  }),
];

reverters.register("workflows.createWorkflow", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: workflow name missing from target.id");
  await ctx.client.jira().delete<unknown>(`/rest/api/3/workflow/${encodeURIComponent(id)}`);
  return { deleted: id };
});

import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDeleteDryRun } from "../../consent/dryRun.js";
import type { ToolContext } from "../types.js";
import { AtlassianApiError } from "../../atlassian/errors.js";
import { ValidationError } from "../../middleware/errorHandler.js";

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

/** An async task (GET /rest/api/3/task/{id}); `id` is the task id, there is no `taskId`. */
interface TaskStatus {
  id?: string;
  status?: string;
  progress?: number;
  [k: string]: unknown;
}

/** Terminal task states — CANCEL_REQUESTED and ENQUEUED/RUNNING are still in flight. */
function isTaskFinished(status: string | undefined): boolean {
  return status === "COMPLETE" || status === "FAILED" || status === "CANCELLED" || status === "DEAD";
}

/**
 * One bulk-read lookup. WorkflowReadRequest is `additionalProperties: false` and
 * takes `workflowNames`/`workflowIds` as arrays of plain STRINGS. An unmatched key
 * answers 404 rather than an empty list, which is a miss, not a failure.
 */
async function readWorkflowBy(ctx: ToolContext, body: Record<string, string[]>): Promise<WorkflowRead | null> {
  try {
    const resp = await ctx.client.jira().post<{ workflows?: WorkflowRead[] }>(`${API}/workflows`, body);
    return resp.data.workflows?.[0] ?? null;
  } catch (err) {
    if (err instanceof AtlassianApiError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * Read one workflow by name or entity id via the bulk read endpoint. The API rejects
 * `workflowNames` and `workflowIds` in the same request, so the two are tried in turn.
 */
async function readWorkflow(ctx: ToolContext, key: string): Promise<WorkflowRead | null> {
  const byName = await readWorkflowBy(ctx, { workflowNames: [key] });
  if (byName) return byName;
  // Fall back to treating the key as an entity id.
  return readWorkflowBy(ctx, { workflowIds: [key] });
}

// Hoisted shared field schemas.
const workflowId = z.string().min(1).describe("Workflow name or entity id");
const transitionId = z.string().min(1).describe("Transition id within the workflow");

/** Shared handler for the three transition-rule ops (rules ride inline on transitions). */
function transitionRuleHandler(ruleField: "conditions" | "validators" | "actions") {
  return async (input: { workflowId: string; transitionId: string }, ctx: ToolContext) => {
    const wf = await readWorkflow(ctx, input.workflowId);
    // Same distinction as getWorkflow: no such workflow ≠ no such transition.
    if (!wf) return { found: false, workflowId: input.workflowId };
    const transition = (wf.transitions ?? []).find((t) => String(t.id) === String(input.transitionId));
    if (!transition) return { found: false, workflowId: input.workflowId, transitionId: input.transitionId };
    return { transitionId: input.transitionId, [ruleField]: transition[ruleField] ?? [] };
  };
}

const workflowsRead = defineOpTool({
  name: "workflows.read",
  description:
    "Read workflows: list/search (listWorkflows), get one workflow (getWorkflow), its transitions (getWorkflowTransitions), or a transition's conditions (getWorkflowConditions), validators (getWorkflowValidators), or post-functions (getWorkflowPostFunctions).",
  group: "read_workflows",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listWorkflows",
      description: "List/search workflows; each result includes its statuses and transitions inline.",
      legacyName: "workflows.listWorkflows",
      input: {
        startAt: z.number().int().nonnegative().default(0).optional().describe("Page offset"),
        maxResults: z.number().int().positive().max(50).default(50).optional().describe("Page size"),
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
    defineOp({
      op: "getWorkflow",
      description: "Get a single workflow (with statuses + transitions) by name or entity id.",
      legacyName: "workflows.getWorkflow",
      input: { workflowId },
      handler: async (input, ctx) => {
        const wf = await readWorkflow(ctx, input.workflowId);
        if (!wf) return { found: false, workflowId: input.workflowId };
        return wf;
      },
    }),
    defineOp({
      op: "getWorkflowTransitions",
      description: "List the transitions of a workflow (each with its conditions, validators and post-functions).",
      legacyName: "workflows.getWorkflowTransitions",
      input: { workflowId },
      handler: async (input, ctx) => {
        const wf = await readWorkflow(ctx, input.workflowId);
        // A missing workflow is not a workflow with zero transitions — say which it is.
        if (!wf) return { found: false, workflowId: input.workflowId };
        return { workflowId: input.workflowId, transitions: wf.transitions ?? [] };
      },
    }),
    defineOp({
      op: "getWorkflowConditions",
      description: "Get the conditions for a workflow transition.",
      legacyName: "workflows.getWorkflowConditions",
      input: { workflowId, transitionId },
      handler: transitionRuleHandler("conditions"),
    }),
    defineOp({
      op: "getWorkflowValidators",
      description: "Get the validators for a workflow transition.",
      legacyName: "workflows.getWorkflowValidators",
      input: { workflowId, transitionId },
      handler: transitionRuleHandler("validators"),
    }),
    defineOp({
      op: "getWorkflowPostFunctions",
      description: "Get the post-functions for a workflow transition (returned under the API's `actions` key).",
      legacyName: "workflows.getWorkflowPostFunctions",
      input: { workflowId, transitionId },
      handler: transitionRuleHandler("actions"),
    }),
  ],
});

// The create and update bulk bodies are DIFFERENT shapes behind one field name —
// advertised as a shared record, precisely validated per op at dispatch.
const wfPayload = z
  .record(z.string(), z.unknown())
  .describe("Bulk API body; exact required shape depends on the op — see the op descriptions");

const createPayloadSchema = z
  .object({
    scope: z.record(z.string(), z.unknown()),
    statuses: z.array(z.record(z.string(), z.unknown())),
    workflows: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .passthrough();

const updatePayloadSchema = z
  .object({
    statuses: z.array(z.record(z.string(), z.unknown())).optional(),
    workflows: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .passthrough();

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, op: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(`Invalid payload for op '${op}'.`, {
      op,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

const workflowsManage = defineOpTool({
  name: "workflows.manage",
  description:
    "Manage workflows: create workflows via the bulk API (createWorkflow), bulk-update them — the only way to change transitions/conditions/validators/post-functions (updateWorkflow), or publish a workflow scheme's draft (publishWorkflowSchemeDraft, async).",
  group: "write_workflows",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createWorkflow",
      description:
        "Create one or more workflows via the bulk create API. `payload` is the POST /workflows/create body: " +
        "{ scope: { type: 'GLOBAL' | 'PROJECT', project? }, statuses: [{ statusReference, name, statusCategory }], " +
        "workflows: [{ name, description?, statuses: [...], transitions: [...] }] }. Use workflows.validateCreateWorkflow first if unsure. Revertible.",
      destructive: true,
      legacyName: "workflows.createWorkflow",
      input: { payload: wfPayload },
      handler: async (input, ctx, meta) => {
        const payload = parsePayload(createPayloadSchema, input.payload, meta.op);
        const names = (payload.workflows as Array<{ name?: string }>).map((w) => w.name).filter(Boolean);
        const dry = meta.dryRun({
          target: { kind: "workflow", name: names.join(", ") },
          before: null,
          after: payload,
          includeFullState: true,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
            const resp = await ctx.client
              .jira()
              .post<{ workflows?: Array<{ id?: string }> }>(`${API}/workflows/create`, payload);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, created: entry.after };
      },
      revert: async (entry, anyCtx) => {
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
      },
    }),
    defineOp({
      op: "updateWorkflow",
      description:
        "Update one or more workflows via the bulk update API. `payload` is the POST /workflows/update body: " +
        "{ statuses: [...], workflows: [{ id, statuses, transitions, ... }] }. This is how transition, condition, " +
        "validator and post-function changes are applied — Jira Cloud has no per-transition REST endpoint.",
      destructive: true,
      legacyName: "workflows.updateWorkflow",
      input: { payload: wfPayload },
      handler: async (input, ctx, meta) => {
        const payload = parsePayload(updatePayloadSchema, input.payload, meta.op);
        const ids = (payload.workflows as Array<{ id?: string }>).map((w) => w.id).filter(Boolean);
        // Capture before-state for each targeted workflow so the change is revertible.
        const before: Record<string, unknown> = {};
        for (const id of ids) before[id as string] = await readWorkflow(ctx, id as string);
        const dry = meta.dryRun({
          target: { kind: "workflow", id: ids.join(",") },
          before,
          after: payload,
          includeFullState: true,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "workflow", id: ids.join(",") },
          before,
          request: { workflows: ids } as Record<string, unknown>,
          revertible: false,
          revertHint: "Re-apply the captured `before` workflow definitions via workflows.manage updateWorkflow.",
          run: async () => {
            const resp = await ctx.client.jira().post<unknown>(`${API}/workflows/update`, payload);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, result: entry.after };
      },
    }),
    defineOp({
      op: "publishWorkflowSchemeDraft",
      description:
        "Publish a workflow SCHEME's draft (this is how workflow changes go live in Jira Cloud — there is no per-workflow " +
        "publish). Asynchronous: Jira runs the publish as a background task, which this op polls for up to ~60s. A result " +
        "with status COMPLETE/FAILED/CANCELLED/DEAD is final; if the budget runs out the result is status RUNNING plus the " +
        "`taskId`, and the caller MUST verify completion itself (GET /rest/api/3/task/{taskId}) — the publish is NOT done yet. " +
        "`statusMappings` maps old→new statuses for in-flight issues.",
      destructive: true,
      legacyName: "workflows.publishWorkflowSchemeDraft",
      input: {
        schemeId: z.string().min(1).describe("Workflow scheme id (see schemes.readConfig listWorkflowSchemes)."),
        statusMappings: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = { statusMappings: input.statusMappings ?? [] };
        const dry = meta.dryRun({
          target: { kind: "workflow_scheme_publish", id: input.schemeId },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const c = ctx.client.jira();
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "workflow_scheme_publish", id: input.schemeId },
          before: null,
          request: { schemeId: input.schemeId } as Record<string, unknown>,
          revertible: false,
          run: async () => {
            // Publish answers 303 See Other with an EMPTY body and a Location pointing at
            // the async task. Axios follows that (same-host) redirect, so what lands here
            // is the task resource itself — keyed `id`; the API never returns a `taskId`.
            const startResp = await c.post<TaskStatus>(
              `${API}/workflowscheme/${encodeURIComponent(input.schemeId)}/draft/publish`,
              body,
            );
            const taskId = startResp.data?.id;
            if (!taskId) {
              return {
                status: "SUBMITTED",
                note: "Publish submitted, but no task id came back; verify the scheme in Jira.",
              };
            }
            if (isTaskFinished(startResp.data.status)) return startResp.data;
            // A scheme switch routinely runs ~30s+, so poll on a backoff within a bounded
            // budget and hand the task id back rather than pretend the publish finished.
            for (let i = 0; i < 15; i++) {
              await new Promise((r) => setTimeout(r, Math.min(1500 + i * 500, 5000)));
              const status = await c.get<TaskStatus>(`${API}/task/${encodeURIComponent(taskId)}`);
              if (isTaskFinished(status.data.status)) return status.data;
            }
            return {
              status: "RUNNING",
              taskId,
              note: `Publish still in progress; poll GET ${API}/task/${taskId} until it is COMPLETE.`,
            };
          },
        });
        return { ok: true, journal_id: entry.opId, result: entry.after };
      },
    }),
  ],
});

const workflowsDelete = defineTool({
  name: "workflows.delete",
  description: "Delete a workflow by name or entity id. Irreversible. The workflow must not be in use by any scheme.",
  group: "write_workflows",
  authMethod: "oauth",
  needsCloudId: true,
  destructive: true,
  legacyName: "workflows.deleteWorkflow",
  input: { workflowId: z.string().min(1).describe("Workflow name or entity id."), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    const c = ctx.client.jira();
    const wf = await readWorkflow(ctx, input.workflowId);
    const entityId = wf?.id ?? input.workflowId;
    if (input.commit !== true) {
      // Don't preview a delete of something that isn't there — a typo'd name would
      // otherwise come back as a perfectly ordinary-looking delete plan.
      if (!wf) return { found: false, workflowId: input.workflowId };
      return buildDeleteDryRun({
        tool: "workflows.delete",
        target: { kind: "workflow", id: entityId },
        before: wf,
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
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
});

// Keeper: non-destructive validation of a create payload — folding it into the
// destructive workflows.manage would flip its annotations, attach the confirm
// card, and force a `commit` it deliberately lacks.
const workflowsValidateCreate = defineTool({
  name: "workflows.validateCreateWorkflow",
  description:
    "Dry-run validation for a create-workflow payload (no changes). Body shape matches workflows.manage createWorkflow payload.",
  group: "write_workflows",
  authMethod: "oauth",
  needsCloudId: true,
  readOnly: true,
  input: { payload: z.record(z.string(), z.unknown()) },
  handler: async (input, ctx) => {
    const resp = await ctx.client.jira().post<unknown>(`${API}/workflows/create/validation`, input.payload);
    return resp.data;
  },
});

export const workflowTools = (): AnyToolDef[] => [
  workflowsRead,
  workflowsManage,
  workflowsDelete,
  workflowsValidateCreate,
];

import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

const AGILE = "/rest/agile/1.0";

export const agileTools = (): AnyToolDef[] => [
  defineTool({
    name: "agile.listBoards",
    description: "List agile boards (Scrum and Kanban).",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(50).default(50).optional(),
      type: z.enum(["scrum", "kanban", "simple"]).optional(),
      name: z.string().optional(),
      projectKeyOrId: z.string().optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      if (input.type) p.set("type", input.type);
      if (input.name) p.set("name", input.name);
      if (input.projectKeyOrId) p.set("projectKeyOrId", input.projectKeyOrId);
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/board?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "agile.getBoard",
    description: "Get a board by id.",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: { boardId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "agile.listSprints",
    description: "List sprints for a board.",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      boardId: z.string().min(1),
      state: z.enum(["future", "active", "closed"]).optional(),
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(50).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      if (input.state) p.set("state", input.state);
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}/sprint?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "agile.getSprint",
    description: "Get a sprint by id.",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: { sprintId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/sprint/${encodeURIComponent(input.sprintId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "agile.createSprint",
    description: "Create a sprint on a Scrum board.",
    group: "write_agile",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      boardId: z.string().min(1),
      name: z.string().min(1),
      goal: z.string().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        originBoardId: Number(input.boardId),
        name: input.name,
        goal: input.goal,
        startDate: input.startDate,
        endDate: input.endDate,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "agile.createSprint",
        target: { kind: "sprint", parent: input.boardId, name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "agile.createSprint",
        cloudId: ctx.cloudId,
        target: { kind: "sprint", parent: input.boardId, name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client.jira().post<unknown>(`${AGILE}/sprint`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, sprint: entry.after };
    },
  }),
  defineTool({
    name: "agile.updateSprint",
    description: "Update a sprint's name/state/dates.",
    group: "write_agile",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      sprintId: z.string().min(1),
      name: z.string().optional(),
      goal: z.string().optional(),
      state: z.enum(["future", "active", "closed"]).optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      completeDate: z.string().datetime().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${AGILE}/sprint/${encodeURIComponent(input.sprintId)}`);
      const body: Record<string, unknown> = {};
      for (const k of ["name", "goal", "state", "startDate", "endDate", "completeDate"] as const) {
        const v = (input as Record<string, unknown>)[k];
        if (v !== undefined) body[k] = v;
      }
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "agile.updateSprint",
        target: { kind: "sprint", id: input.sprintId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "agile.updateSprint",
        cloudId: ctx.cloudId,
        target: { kind: "sprint", id: input.sprintId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "POST the captured `before` payload back.",
        run: async () => {
          const resp = await c.post<unknown>(`${AGILE}/sprint/${encodeURIComponent(input.sprintId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "agile.listEpics",
    description: "List epics on a board.",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      boardId: z.string().min(1),
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(50).default(50).optional(),
      done: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      if (input.done !== undefined) p.set("done", String(input.done));
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}/epic?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "agile.getEpic",
    description: "Get an epic by id or key.",
    group: "read_agile",
    authMethod: "oauth",
    needsCloudId: true,
    input: { epicId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${AGILE}/epic/${encodeURIComponent(input.epicId)}`);
      return resp.data;
    },
  }),
];

// Reverting a sprint update = POST the prior value of exactly the fields the
// update touched back to the same sprint. POST /sprint/{id} is a PARTIAL update,
// so a field the update ADDED (absent from `before`) is sent back as null to
// clear it rather than left in place.
reverters.register("agile.updateSprint", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: sprint id missing from target.");
  const before = entry.before as Record<string, unknown> | null;
  if (!before) throw new Error("Cannot revert: journal entry has no captured `before` sprint.");
  const body: Record<string, unknown> = {};
  for (const k of ["name", "goal", "state", "startDate", "endDate", "completeDate"] as const) {
    if (k in entry.request) body[k] = before[k] ?? null;
  }
  const resp = await ctx.client.jira().post<unknown>(`${AGILE}/sprint/${encodeURIComponent(id)}`, body);
  return { reverted: id, response: resp.data };
});

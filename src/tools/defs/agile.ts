import { z } from "zod";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import type { ToolContext } from "../types.js";

const AGILE = "/rest/agile/1.0";

// Hoisted shared field schemas — ops sharing a field name must share ONE base
// instance (required-ness wrappers may differ per op).
const boardId = z.string().min(1).describe("Board id");
const sprintId = z.string().min(1).describe("Sprint id");
const startAt = z.number().int().nonnegative().default(0).describe("Page offset");
const maxResults = z.number().int().positive().max(50).default(50).describe("Page size");
const sprintName = z.string().min(1).describe("Sprint name");
const sprintGoal = z.string().describe("Sprint goal");
const sprintStart = z.string().datetime().describe("Start date (ISO)");
const sprintEnd = z.string().datetime().describe("End date (ISO)");

const agileRead = defineOpTool({
  name: "agile.read",
  description:
    "Read agile data: list boards (listBoards), get a board (getBoard), list a board's sprints (listSprints) or epics (listEpics), get a sprint (getSprint) or an epic (getEpic).",
  group: "read_agile",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listBoards",
      description: "List agile boards (Scrum and Kanban), filterable by type/name/project.",
      legacyName: "agile.listBoards",
      input: {
        startAt: startAt.optional(),
        maxResults: maxResults.optional(),
        type: z.enum(["scrum", "kanban", "simple"]).optional(),
        name: z.string().optional().describe("Board name filter"),
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
    defineOp({
      op: "getBoard",
      description: "Get a board by id.",
      legacyName: "agile.getBoard",
      input: { boardId },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listSprints",
      description: "List sprints for a board, filterable by state.",
      legacyName: "agile.listSprints",
      input: {
        boardId,
        state: z.enum(["future", "active", "closed"]).optional(),
        startAt: startAt.optional(),
        maxResults: maxResults.optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          maxResults: String(input.maxResults ?? 50),
        });
        if (input.state) p.set("state", input.state);
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}/sprint?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getSprint",
      description: "Get a sprint by id.",
      legacyName: "agile.getSprint",
      input: { sprintId },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${AGILE}/sprint/${encodeURIComponent(input.sprintId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listEpics",
      description: "List epics on a board, filterable by done state.",
      legacyName: "agile.listEpics",
      input: {
        boardId,
        startAt: startAt.optional(),
        maxResults: maxResults.optional(),
        done: z.boolean().optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          maxResults: String(input.maxResults ?? 50),
        });
        if (input.done !== undefined) p.set("done", String(input.done));
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${AGILE}/board/${encodeURIComponent(input.boardId)}/epic?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getEpic",
      description: "Get an epic by id or key.",
      legacyName: "agile.getEpic",
      input: { epicId: z.string().min(1).describe("Epic id or key") },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${AGILE}/epic/${encodeURIComponent(input.epicId)}`);
        return resp.data;
      },
    }),
  ],
});

const agileManageSprint = defineOpTool({
  name: "agile.manageSprint",
  description:
    "Create a sprint on a Scrum board (createSprint) or update a sprint's name, goal, state, or dates (updateSprint — revertible).",
  group: "write_agile",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createSprint",
      description: "Create a sprint on a Scrum board.",
      destructive: true,
      legacyName: "agile.createSprint",
      input: {
        boardId,
        name: sprintName,
        goal: sprintGoal.optional(),
        startDate: sprintStart.optional(),
        endDate: sprintEnd.optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          originBoardId: Number(input.boardId),
          name: input.name,
          goal: input.goal,
          startDate: input.startDate,
          endDate: input.endDate,
        };
        const dry = meta.dryRun({
          target: { kind: "sprint", parent: input.boardId, name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "updateSprint",
      description: "Update a sprint's name/goal/state/dates. Journals only the touched fields; revertible.",
      destructive: true,
      legacyName: "agile.updateSprint",
      input: {
        sprintId,
        name: sprintName.optional(),
        goal: sprintGoal.optional(),
        state: z.enum(["future", "active", "closed"]).optional().describe("Target sprint state"),
        startDate: sprintStart.optional(),
        endDate: sprintEnd.optional(),
        completeDate: z.string().datetime().optional().describe("Completion date (ISO)"),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(`${AGILE}/sprint/${encodeURIComponent(input.sprintId)}`);
        const body: Record<string, unknown> = {};
        for (const k of ["name", "goal", "state", "startDate", "endDate", "completeDate"] as const) {
          const v = (input as Record<string, unknown>)[k];
          if (v !== undefined) body[k] = v;
        }
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "sprint", id: input.sprintId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        // Journal request = the touched fields only (plus the injected op):
        // the reverter's `k in entry.request` probes key off field presence.
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting a sprint update = POST the prior value of exactly the fields
      // the update touched back to the same sprint. POST /sprint/{id} is a
      // PARTIAL update, so a field the update ADDED (absent from `before`) is
      // sent back as null to clear it rather than left in place.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
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
      },
    }),
  ],
});

export const agileTools = (): AnyToolDef[] => [agileRead, agileManageSprint];

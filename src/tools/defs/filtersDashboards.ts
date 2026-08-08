import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDeleteDryRun } from "../../consent/dryRun.js";
import type { ToolContext } from "../types.js";

const API = "/rest/api/3";

// ---- Filters -----------------------------------------------------------------

const filterId = z.string().min(1).describe("Filter id");
const filterName = z.string().min(1).describe("Filter name");
const filterJql = z.string().min(1).describe("JQL the filter runs");
const filterDescription = z.string().describe("Filter description");
const filterFavourite = z.boolean().describe("Mark as favourite");
const filterShares = z.array(z.record(z.string(), z.unknown())).describe("Share permission objects");
const fdStartAt = z.number().int().nonnegative().default(0).describe("Page offset");
const fdMaxResults = z.number().int().positive().max(100).default(50).describe("Page size");

const filtersRead = defineOpTool({
  name: "filters.read",
  description: "Read saved filters: paged list/search by name (listFilters) or get one filter (getFilter).",
  group: "read_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listFilters",
      description: "List Jira filters (paginated), optionally matching a name.",
      legacyName: "filters.listFilters",
      input: {
        startAt: fdStartAt.optional(),
        maxResults: fdMaxResults.optional(),
        filterName: z.string().optional().describe("Name filter for the search"),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          maxResults: String(input.maxResults ?? 50),
        });
        if (input.filterName) p.set("filterName", input.filterName);
        const resp = await ctx.client.jira().get<unknown>(`${API}/filter/search?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getFilter",
      description: "Get a filter by id.",
      legacyName: "filters.getFilter",
      input: { filterId },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
        return resp.data;
      },
    }),
  ],
});

const filtersManage = defineOpTool({
  name: "filters.manage",
  description:
    "Create a saved filter (createFilter: name + JQL + sharing) or update one (updateFilter — revertible; PUT semantics carry existing name/JQL for partial updates).",
  group: "write_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createFilter",
      description: "Create a filter.",
      destructive: true,
      legacyName: "filters.createFilter",
      input: {
        name: filterName,
        jql: filterJql,
        description: filterDescription.optional(),
        favourite: filterFavourite.optional(),
        sharePermissions: filterShares.optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          name: input.name,
          jql: input.jql,
          description: input.description,
          favourite: input.favourite,
          sharePermissions: input.sharePermissions,
        };
        const dry = meta.dryRun({
          target: { kind: "filter", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "filter", name: input.name },
          before: null,
          request: body as Record<string, unknown>,
          revertible: false,
          run: async () => {
            const resp = await ctx.client.jira().post<unknown>(`${API}/filter`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, filter: entry.after };
      },
    }),
    defineOp({
      op: "updateFilter",
      description: "Update a filter. Journals only the touched fields; revertible.",
      destructive: true,
      legacyName: "filters.updateFilter",
      input: {
        filterId,
        name: filterName.optional(),
        jql: filterJql.optional(),
        description: filterDescription.optional(),
        favourite: filterFavourite.optional(),
        sharePermissions: filterShares.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
        const prev = before.data as { name?: string; jql?: string };
        // PUT /filter/{id} requires name AND jql. Partial updates (e.g. JQL-only)
        // must carry the existing values or the request 400s. Merge from before.
        const body: Record<string, unknown> = {
          name: input.name ?? prev.name,
          jql: input.jql ?? prev.jql,
        };
        for (const k of ["description", "favourite", "sharePermissions"] as const) {
          const v = (input as Record<string, unknown>)[k];
          if (v !== undefined) body[k] = v;
        }
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "filter", id: input.filterId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "filter", id: input.filterId },
          before: before.data,
          request: body,
          revertible: true,
          revertHint: "PUT the captured `before` payload back.",
          run: async () => {
            const resp = await c.put<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
      // Reverting a filter update = PUT the captured `before` back. PUT
      // /filter/{id} requires name AND jql, so both always ride along; the
      // optional fields are restored only when the update touched them (absent
      // from `before` means they were unset, so send the empty value rather
      // than leaving what the update added).
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: filter id missing from target.");
        const before = entry.before as {
          name?: string;
          jql?: string;
          description?: string;
          favourite?: boolean;
          sharePermissions?: unknown[];
        } | null;
        if (!before?.name || !before.jql)
          throw new Error("Cannot revert: journal entry has no captured `before` filter name/jql.");
        const body: Record<string, unknown> = { name: before.name, jql: before.jql };
        if ("description" in entry.request) body.description = before.description ?? "";
        if ("favourite" in entry.request) body.favourite = before.favourite ?? false;
        if ("sharePermissions" in entry.request) body.sharePermissions = before.sharePermissions ?? [];
        const resp = await ctx.client.jira().put<unknown>(`${API}/filter/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
  ],
});

const filtersDelete = defineTool({
  name: "filters.delete",
  description: "Delete a filter. Irreversible.",
  group: "write_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  destructive: true,
  legacyName: "filters.deleteFilter",
  input: { filterId: z.string().min(1), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    const c = ctx.client.jira();
    const before = await c.get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
    if (input.commit !== true) {
      return buildDeleteDryRun({
        tool: "filters.delete",
        target: { kind: "filter", id: input.filterId },
        before: before.data,
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
      target: { kind: "filter", id: input.filterId },
      before: before.data,
      request: { filterId: input.filterId } as Record<string, unknown>,
      revertible: false,
      run: async () => {
        await c.delete<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
        return { deleted: input.filterId };
      },
    });
    return { ok: true, journal_id: entry.opId };
  },
});

// ---- Dashboards --------------------------------------------------------------

const dashboardId = z.string().min(1).describe("Dashboard id");
const dashboardName = z.string().min(1).describe("Dashboard name");
const dashboardDescription = z.string().describe("Dashboard description");
const dashboardShares = z.array(z.record(z.string(), z.unknown())).describe("Share permission objects");
const dashboardEdits = z.array(z.record(z.string(), z.unknown())).describe("Edit permission objects");
const dbStartAt = z.number().int().nonnegative().default(0).describe("Page offset");
const dbMaxResults = z.number().int().positive().max(100).default(50).describe("Page size");

const dashboardsRead = defineOpTool({
  name: "dashboards.read",
  description:
    "Read dashboards: paged list, optionally scoped to favourite/my (listDashboards), or get one dashboard (getDashboard).",
  group: "read_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listDashboards",
      description: "List dashboards (all, favourite, or my).",
      legacyName: "dashboards.listDashboards",
      input: {
        startAt: dbStartAt.optional(),
        maxResults: dbMaxResults.optional(),
        filter: z.enum(["favourite", "my"]).optional().describe("Scope of the listing"),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          maxResults: String(input.maxResults ?? 50),
        });
        if (input.filter) p.set("filter", input.filter);
        const resp = await ctx.client.jira().get<unknown>(`${API}/dashboard?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getDashboard",
      description: "Get a dashboard by id.",
      legacyName: "dashboards.getDashboard",
      input: { dashboardId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
        return resp.data;
      },
    }),
  ],
});

const dashboardsManage = defineOpTool({
  name: "dashboards.manage",
  description:
    "Create a dashboard (createDashboard: name + share/edit permissions) or update one (updateDashboard — revertible; PUT semantics carry existing values for partial updates).",
  group: "write_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createDashboard",
      description: "Create a dashboard.",
      destructive: true,
      legacyName: "dashboards.createDashboard",
      input: {
        name: dashboardName,
        description: dashboardDescription.optional(),
        sharePermissions: dashboardShares.optional(),
        editPermissions: dashboardEdits.optional(),
      },
      handler: async (input, ctx, meta) => {
        // POST /dashboard requires name, sharePermissions AND editPermissions.
        const body = {
          name: input.name,
          description: input.description,
          sharePermissions: input.sharePermissions ?? [],
          editPermissions: input.editPermissions ?? [],
        };
        const dry = meta.dryRun({
          target: { kind: "dashboard", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "dashboard", name: input.name },
          before: null,
          request: body as Record<string, unknown>,
          revertible: false,
          run: async () => {
            const resp = await ctx.client.jira().post<unknown>(`${API}/dashboard`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, dashboard: entry.after };
      },
    }),
    defineOp({
      op: "updateDashboard",
      description: "Update a dashboard. Revertible.",
      destructive: true,
      legacyName: "dashboards.updateDashboard",
      input: {
        dashboardId,
        name: dashboardName.optional(),
        description: dashboardDescription.optional(),
        sharePermissions: dashboardShares.optional(),
        editPermissions: dashboardEdits.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
        const prev = before.data as {
          name?: string;
          description?: string;
          sharePermissions?: unknown[];
          editPermissions?: unknown[];
        };
        // PUT /dashboard/{id} requires name, sharePermissions AND editPermissions.
        // Carry the existing values for anything the caller didn't override.
        const body: Record<string, unknown> = {
          name: input.name ?? prev.name,
          sharePermissions: input.sharePermissions ?? prev.sharePermissions ?? [],
          editPermissions: input.editPermissions ?? prev.editPermissions ?? [],
        };
        const description = input.description ?? prev.description;
        if (description !== undefined) body.description = description;
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "dashboard", id: input.dashboardId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "dashboard", id: input.dashboardId },
          before: before.data,
          request: body,
          revertible: true,
          revertHint: "PUT the captured `before` payload back.",
          run: async () => {
            const resp = await c.put<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
      // Reverting a dashboard update = PUT the captured `before` back. PUT
      // /dashboard/{id} requires name, sharePermissions AND editPermissions;
      // description is always sent (defaulting to "") so a description the
      // update ADDED is cleared rather than left in place.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: dashboard id missing from target.");
        const before = entry.before as {
          name?: string;
          description?: string;
          sharePermissions?: unknown[];
          editPermissions?: unknown[];
        } | null;
        if (!before?.name)
          throw new Error("Cannot revert: journal entry has no captured `before` dashboard name.");
        const body: Record<string, unknown> = {
          name: before.name,
          description: before.description ?? "",
          sharePermissions: before.sharePermissions ?? [],
          editPermissions: before.editPermissions ?? [],
        };
        const resp = await ctx.client.jira().put<unknown>(`${API}/dashboard/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
  ],
});

const dashboardsDelete = defineTool({
  name: "dashboards.delete",
  description: "Delete a dashboard. Irreversible.",
  group: "write_filters_dashboards",
  authMethod: "oauth",
  needsCloudId: true,
  destructive: true,
  legacyName: "dashboards.deleteDashboard",
  input: { dashboardId: z.string().min(1), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    const c = ctx.client.jira();
    const before = await c.get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
    if (input.commit !== true) {
      return buildDeleteDryRun({
        tool: "dashboards.delete",
        target: { kind: "dashboard", id: input.dashboardId },
        before: before.data,
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
      target: { kind: "dashboard", id: input.dashboardId },
      before: before.data,
      request: { dashboardId: input.dashboardId } as Record<string, unknown>,
      revertible: false,
      run: async () => {
        await c.delete<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
        return { deleted: input.dashboardId };
      },
    });
    return { ok: true, journal_id: entry.opId };
  },
});

export const filterDashboardTools = (): AnyToolDef[] => [
  filtersRead,
  filtersManage,
  filtersDelete,
  dashboardsRead,
  dashboardsManage,
  dashboardsDelete,
];

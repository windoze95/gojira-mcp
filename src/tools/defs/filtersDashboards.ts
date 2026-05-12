import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";

const API = "/rest/api/3";

export const filterDashboardTools = (): AnyToolDef[] => [
  // ---- Filters ----
  defineTool({
    name: "filters.listFilters",
    description: "List Jira filters (paginated).",
    group: "read_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
      filterName: z.string().optional(),
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
  defineTool({
    name: "filters.getFilter",
    description: "Get a filter by id.",
    group: "read_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    input: { filterId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "filters.createFilter",
    description: "Create a filter.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      jql: z.string().min(1),
      description: z.string().optional(),
      favourite: z.boolean().optional(),
      sharePermissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        name: input.name,
        jql: input.jql,
        description: input.description,
        favourite: input.favourite,
        sharePermissions: input.sharePermissions,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "filters.createFilter",
        target: { kind: "filter", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "filters.createFilter",
        cloudId: ctx.cloudId,
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
  defineTool({
    name: "filters.updateFilter",
    description: "Update a filter.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      filterId: z.string().min(1),
      name: z.string().optional(),
      jql: z.string().optional(),
      description: z.string().optional(),
      favourite: z.boolean().optional(),
      sharePermissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
      const body: Record<string, unknown> = {};
      for (const k of ["name", "jql", "description", "favourite", "sharePermissions"] as const) {
        const v = (input as Record<string, unknown>)[k];
        if (v !== undefined) body[k] = v;
      }
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "filters.updateFilter",
        target: { kind: "filter", id: input.filterId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "filters.updateFilter",
        cloudId: ctx.cloudId,
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
  }),
  defineTool({
    name: "filters.deleteFilter",
    description: "Delete a filter. Irreversible.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { filterId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/filter/${encodeURIComponent(input.filterId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "filters.deleteFilter",
          target: { kind: "filter", id: input.filterId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "filters.deleteFilter",
        cloudId: ctx.cloudId,
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
  }),

  // ---- Dashboards ----
  defineTool({
    name: "dashboards.listDashboards",
    description: "List dashboards.",
    group: "read_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
      filter: z.enum(["favourite", "my"]).optional(),
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
  defineTool({
    name: "dashboards.getDashboard",
    description: "Get a dashboard by id.",
    group: "read_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    input: { dashboardId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "dashboards.createDashboard",
    description: "Create a dashboard.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      sharePermissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { name: input.name, description: input.description, sharePermissions: input.sharePermissions ?? [] };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "dashboards.createDashboard",
        target: { kind: "dashboard", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "dashboards.createDashboard",
        cloudId: ctx.cloudId,
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
  defineTool({
    name: "dashboards.updateDashboard",
    description: "Update a dashboard.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      dashboardId: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      sharePermissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
      const body: Record<string, unknown> = {};
      for (const k of ["name", "description", "sharePermissions"] as const) {
        const v = (input as Record<string, unknown>)[k];
        if (v !== undefined) body[k] = v;
      }
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "dashboards.updateDashboard",
        target: { kind: "dashboard", id: input.dashboardId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "dashboards.updateDashboard",
        cloudId: ctx.cloudId,
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
  }),
  defineTool({
    name: "dashboards.deleteDashboard",
    description: "Delete a dashboard. Irreversible.",
    group: "write_filters_dashboards",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { dashboardId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${API}/dashboard/${encodeURIComponent(input.dashboardId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "dashboards.deleteDashboard",
          target: { kind: "dashboard", id: input.dashboardId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "dashboards.deleteDashboard",
        cloudId: ctx.cloudId,
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
  }),
];

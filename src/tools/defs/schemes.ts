import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Scheme tools (permission, notification, workflow, screen, screen
 * scheme, issue type scheme, field configuration). All OAuth.
 *
 * Reads use /rest/api/3 paginated endpoints; writes wrap in consent + journal.
 */

const API = "/rest/api/3";

function paginatedListInput() {
  return {
    startAt: z.number().int().nonnegative().default(0).optional(),
    maxResults: z.number().int().positive().max(100).default(50).optional(),
  };
}

const PERMISSION_SCHEME_PATH = `${API}/permissionscheme`;
const NOTIFICATION_SCHEME_PATH = `${API}/notificationscheme`;
const WORKFLOW_SCHEME_PATH = `${API}/workflowscheme`;
const SCREEN_PATH = `${API}/screens`;
const SCREEN_SCHEME_PATH = `${API}/screenscheme`;
const ISSUE_TYPE_SCHEME_PATH = `${API}/issuetypescheme`;
const FIELD_CONFIG_PATH = `${API}/fieldconfiguration`;

export const schemeTools = (): AnyToolDef[] => [
  // ---- Permission schemes ----
  defineTool({
    name: "schemes.listPermissionSchemes",
    description: "List Jira permission schemes.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    handler: async (_input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(PERMISSION_SCHEME_PATH);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getPermissionScheme",
    description: "Get a single permission scheme (with full grant list when expand='all').",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemeId: z.string().min(1), expand: z.array(z.string()).optional() },
    handler: async (input, ctx) => {
      const ex = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
      const resp = await ctx.client.jira().get<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}${ex}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.createPermissionScheme",
    description: "Create a permission scheme.",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      permissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { name: input.name, description: input.description, permissions: input.permissions };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "schemes.createPermissionScheme",
        target: { kind: "permission_scheme", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.createPermissionScheme",
        cloudId: ctx.cloudId,
        target: { kind: "permission_scheme", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created permission scheme.",
        deriveTargetId: (after) => (after as { id?: string | number })?.id?.toString(),
        run: async () => {
          const resp = await ctx.client.jira().post<{ id: string }>(PERMISSION_SCHEME_PATH, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, scheme: entry.after };
    },
  }),
  defineTool({
    name: "schemes.updatePermissionScheme",
    description: "Update a permission scheme (PUT-replace semantics).",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      schemeId: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      permissions: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}?expand=all`);
      const prev = before.data as { name?: string };
      // PUT /permissionscheme/{id} requires `name`. A description- or
      // permissions-only update must still carry the existing name or it 400s.
      const body: Record<string, unknown> = { name: input.name ?? prev.name };
      if (input.description !== undefined) body.description = input.description;
      if (input.permissions !== undefined) body.permissions = input.permissions;
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "schemes.updatePermissionScheme",
        target: { kind: "permission_scheme", id: input.schemeId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.updatePermissionScheme",
        cloudId: ctx.cloudId,
        target: { kind: "permission_scheme", id: input.schemeId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "schemes.deletePermissionScheme",
    description: "Delete a permission scheme. Irreversible.",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { schemeId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}?expand=all`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "schemes.deletePermissionScheme",
          target: { kind: "permission_scheme", id: input.schemeId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.deletePermissionScheme",
        cloudId: ctx.cloudId,
        target: { kind: "permission_scheme", id: input.schemeId },
        before: before.data,
        request: { schemeId: input.schemeId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
          return { deleted: input.schemeId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "schemes.assignPermissionSchemeToProject",
    description: "Assign a permission scheme to a project. Revertible (restore prior assignment).",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { projectKeyOrId: z.string().min(1), schemeId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const beforeResp = await c.get<unknown>(
        `${API}/project/${encodeURIComponent(input.projectKeyOrId)}/permissionscheme`,
      );
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "schemes.assignPermissionSchemeToProject",
        target: { kind: "project_permission_scheme", id: input.projectKeyOrId },
        before: beforeResp.data,
        after: { id: input.schemeId },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.assignPermissionSchemeToProject",
        cloudId: ctx.cloudId,
        target: { kind: "project_permission_scheme", id: input.projectKeyOrId },
        before: beforeResp.data,
        request: { schemeId: input.schemeId } as Record<string, unknown>,
        revertible: true,
        revertHint: "Call assignPermissionSchemeToProject with the captured `before.id`.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${API}/project/${encodeURIComponent(input.projectKeyOrId)}/permissionscheme`,
            { id: input.schemeId },
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // ---- Notification schemes ----
  defineTool({
    name: "schemes.listNotificationSchemes",
    description: "List notification schemes.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${NOTIFICATION_SCHEME_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getNotificationScheme",
    description: "Get a notification scheme.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemeId: z.string().min(1), expand: z.array(z.string()).optional() },
    handler: async (input, ctx) => {
      const ex = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
      const resp = await ctx.client.jira().get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}${ex}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.createNotificationScheme",
    description: "Create a notification scheme.",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      description: z.string().optional(),
      notificationSchemeEvents: z.array(z.record(z.string(), z.unknown())).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        name: input.name,
        description: input.description,
        notificationSchemeEvents: input.notificationSchemeEvents,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "schemes.createNotificationScheme",
        target: { kind: "notification_scheme", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.createNotificationScheme",
        cloudId: ctx.cloudId,
        target: { kind: "notification_scheme", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created notification scheme.",
        deriveTargetId: (after) => (after as { id?: string | number })?.id?.toString(),
        run: async () => {
          const resp = await ctx.client.jira().post<{ id: string }>(NOTIFICATION_SCHEME_PATH, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, scheme: entry.after };
    },
  }),
  defineTool({
    name: "schemes.updateNotificationScheme",
    description: "Update a notification scheme.",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      schemeId: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "schemes.updateNotificationScheme",
        target: { kind: "notification_scheme", id: input.schemeId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.updateNotificationScheme",
        cloudId: ctx.cloudId,
        target: { kind: "notification_scheme", id: input.schemeId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "schemes.deleteNotificationScheme",
    description: "Delete a notification scheme. Irreversible.",
    group: "write_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { schemeId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "schemes.deleteNotificationScheme",
          target: { kind: "notification_scheme", id: input.schemeId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "schemes.deleteNotificationScheme",
        cloudId: ctx.cloudId,
        target: { kind: "notification_scheme", id: input.schemeId },
        before: before.data,
        request: { schemeId: input.schemeId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
          return { deleted: input.schemeId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // ---- Workflow schemes ----
  defineTool({
    name: "schemes.listWorkflowSchemes",
    description: "List workflow schemes.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${WORKFLOW_SCHEME_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getWorkflowScheme",
    description: "Get a workflow scheme.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${WORKFLOW_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
      return resp.data;
    },
  }),

  // ---- Screens & screen schemes ----
  defineTool({
    name: "schemes.listScreens",
    description: "List screens.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${SCREEN_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getScreen",
    description: "Get a screen by id.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { screenId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${SCREEN_PATH}/${encodeURIComponent(input.screenId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.listScreenSchemes",
    description: "List screen schemes.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${SCREEN_SCHEME_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),

  // ---- Issue type schemes ----
  defineTool({
    name: "schemes.listIssueTypeSchemes",
    description: "List issue-type schemes.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${ISSUE_TYPE_SCHEME_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getIssueTypeScheme",
    description: "Get an issue-type scheme.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemeId: z.string().min(1) },
    handler: async (input, ctx) => {
      // List by ID via the ?id query.
      const resp = await ctx.client.jira().get<unknown>(`${ISSUE_TYPE_SCHEME_PATH}?id=${encodeURIComponent(input.schemeId)}`);
      return resp.data;
    },
  }),

  // ---- Field configurations ----
  defineTool({
    name: "schemes.listFieldConfigurations",
    description: "List field configurations.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: paginatedListInput(),
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client.jira().get<unknown>(`${FIELD_CONFIG_PATH}?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "schemes.getFieldConfiguration",
    description: "Get a field configuration by id.",
    group: "read_schemes",
    authMethod: "oauth",
    needsCloudId: true,
    input: { configId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.jira().get<unknown>(`${FIELD_CONFIG_PATH}?id=${encodeURIComponent(input.configId)}`);
      return resp.data;
    },
  }),
];

// Reverter for permission scheme assignment (D2 example).
reverters.register("schemes.assignPermissionSchemeToProject", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const before = entry.before as { id?: string } | null;
  const t = entry.target as { id?: string };
  if (!before?.id || !t.id) throw new Error("Cannot revert: missing before.id or target.id");
  await ctx.client
    .jira()
    .put<unknown>(`/rest/api/3/project/${encodeURIComponent(t.id)}/permissionscheme`, { id: before.id });
  return { restored_scheme_id: before.id };
});

reverters.register("schemes.createPermissionScheme", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: created scheme id missing.");
  await ctx.client.jira().delete<unknown>(`/rest/api/3/permissionscheme/${encodeURIComponent(id)}`);
  return { deleted: id };
});

reverters.register("schemes.createNotificationScheme", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: created scheme id missing.");
  await ctx.client.jira().delete<unknown>(`/rest/api/3/notificationscheme/${encodeURIComponent(id)}`);
  return { deleted: id };
});

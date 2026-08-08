import { z } from "zod";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import type { ToolContext } from "../types.js";

/**
 * Scheme tools (permission, notification, workflow, screen, screen
 * scheme, issue type scheme, field configuration). All OAuth.
 *
 * Reads use /rest/api/3 paginated endpoints; writes wrap in consent + journal.
 */

const API = "/rest/api/3";

const PERMISSION_SCHEME_PATH = `${API}/permissionscheme`;
const NOTIFICATION_SCHEME_PATH = `${API}/notificationscheme`;
const WORKFLOW_SCHEME_PATH = `${API}/workflowscheme`;
const SCREEN_PATH = `${API}/screens`;
const SCREEN_SCHEME_PATH = `${API}/screenscheme`;
const ISSUE_TYPE_SCHEME_PATH = `${API}/issuetypescheme`;
const FIELD_CONFIG_PATH = `${API}/fieldconfiguration`;

// Hoisted shared field schemas — ops sharing a field name must share ONE base.
const pagingStartAt = z.number().int().nonnegative().default(0).describe("Page offset");
const pagingMaxResults = z.number().int().positive().max(100).default(50).describe("Page size");

function pagedQuery(input: { startAt?: number; maxResults?: number }): string {
  return new URLSearchParams({
    startAt: String(input.startAt ?? 0),
    maxResults: String(input.maxResults ?? 50),
  }).toString();
}

// ---- read_schemes ------------------------------------------------------------

const accessSchemeId = z
  .string()
  .min(1)
  .describe("Scheme id — a PERMISSION scheme id for the permission ops, a NOTIFICATION scheme id for the notification ops");
const accessExpand = z.array(z.string()).describe("Expand parameters (e.g. 'all' for the full grant list)");

const schemesReadAccess = defineOpTool({
  name: "schemes.readAccess",
  description:
    "Read access-control schemes: list permission schemes (listPermissionSchemes), get one (getPermissionScheme), list notification schemes (listNotificationSchemes), get one (getNotificationScheme).",
  group: "read_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listPermissionSchemes",
      description: "List Jira permission schemes.",
      legacyName: "schemes.listPermissionSchemes",
      handler: async (_input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(PERMISSION_SCHEME_PATH);
        return resp.data;
      },
    }),
    defineOp({
      op: "getPermissionScheme",
      description: "Get a single permission scheme (full grant list when expand includes 'all').",
      legacyName: "schemes.getPermissionScheme",
      input: { schemeId: accessSchemeId, expand: accessExpand.optional() },
      handler: async (input, ctx) => {
        const ex = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}${ex}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listNotificationSchemes",
      description: "List notification schemes (paginated).",
      legacyName: "schemes.listNotificationSchemes",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${NOTIFICATION_SCHEME_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getNotificationScheme",
      description: "Get a notification scheme.",
      legacyName: "schemes.getNotificationScheme",
      input: { schemeId: accessSchemeId, expand: accessExpand.optional() },
      handler: async (input, ctx) => {
        const ex = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}${ex}`);
        return resp.data;
      },
    }),
  ],
});

const schemesReadScreen = defineOpTool({
  name: "schemes.readScreen",
  description:
    "Read screens and screen schemes: list screens (listScreens), get a screen by id (getScreen), list screen schemes (listScreenSchemes).",
  group: "read_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listScreens",
      description: "List screens (paginated).",
      legacyName: "schemes.listScreens",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${SCREEN_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getScreen",
      description: "Get a screen by id.",
      legacyName: "schemes.getScreen",
      input: { screenId: z.string().min(1).describe("Screen id") },
      handler: async (input, ctx) => {
        // There is no GET /screens/{id} (that path is PUT/DELETE only).
        // List by ID via the ?id query.
        const resp = await ctx.client.jira().get<unknown>(`${SCREEN_PATH}?id=${encodeURIComponent(input.screenId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listScreenSchemes",
      description: "List screen schemes (paginated).",
      legacyName: "schemes.listScreenSchemes",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${SCREEN_SCHEME_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
  ],
});

const configSchemeId = z
  .string()
  .min(1)
  .describe("Scheme id — a WORKFLOW scheme id for getWorkflowScheme, an ISSUE-TYPE scheme id for getIssueTypeScheme");

const schemesReadConfig = defineOpTool({
  name: "schemes.readConfig",
  description:
    "Read issue-configuration schemes: list/get workflow schemes (listWorkflowSchemes, getWorkflowScheme), issue-type schemes (listIssueTypeSchemes, getIssueTypeScheme), and field configurations (listFieldConfigurations, getFieldConfiguration).",
  group: "read_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listWorkflowSchemes",
      description: "List workflow schemes (paginated).",
      legacyName: "schemes.listWorkflowSchemes",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${WORKFLOW_SCHEME_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getWorkflowScheme",
      description: "Get a workflow scheme.",
      legacyName: "schemes.getWorkflowScheme",
      input: { schemeId: configSchemeId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${WORKFLOW_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listIssueTypeSchemes",
      description: "List issue-type schemes (paginated).",
      legacyName: "schemes.listIssueTypeSchemes",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${ISSUE_TYPE_SCHEME_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getIssueTypeScheme",
      description: "Get an issue-type scheme.",
      legacyName: "schemes.getIssueTypeScheme",
      input: { schemeId: configSchemeId },
      handler: async (input, ctx) => {
        // List by ID via the ?id query.
        const resp = await ctx.client
          .jira()
          .get<unknown>(`${ISSUE_TYPE_SCHEME_PATH}?id=${encodeURIComponent(input.schemeId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listFieldConfigurations",
      description: "List field configurations (paginated).",
      legacyName: "schemes.listFieldConfigurations",
      input: { startAt: pagingStartAt.optional(), maxResults: pagingMaxResults.optional() },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${FIELD_CONFIG_PATH}?${pagedQuery(input)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getFieldConfiguration",
      description: "Get a field configuration by id.",
      legacyName: "schemes.getFieldConfiguration",
      input: { configId: z.string().min(1).describe("Field configuration id") },
      handler: async (input, ctx) => {
        const resp = await ctx.client.jira().get<unknown>(`${FIELD_CONFIG_PATH}?id=${encodeURIComponent(input.configId)}`);
        return resp.data;
      },
    }),
  ],
});

// ---- write_schemes -----------------------------------------------------------

const permSchemeName = z.string().min(1).describe("Permission scheme name");
const permSchemeDescription = z.string().describe("Permission scheme description");
const permSchemeGrants = z.array(z.record(z.string(), z.unknown())).describe("Permission grant objects");
const permSchemeId = z
  .string()
  .min(1)
  .describe("Permission scheme id (target for update; the scheme to assign for assignPermissionSchemeToProject)");

const schemesManagePermission = defineOpTool({
  name: "schemes.managePermission",
  description:
    "Manage permission schemes: create one (createPermissionScheme), update one — PUT-replace semantics (updatePermissionScheme), or assign one to a project (assignPermissionSchemeToProject). All revertible.",
  group: "write_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createPermissionScheme",
      description: "Create a permission scheme.",
      destructive: true,
      legacyName: "schemes.createPermissionScheme",
      input: {
        name: permSchemeName,
        description: permSchemeDescription.optional(),
        permissions: permSchemeGrants.optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = { name: input.name, description: input.description, permissions: input.permissions };
        const dry = meta.dryRun({
          target: { kind: "permission_scheme", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: created scheme id missing.");
        await ctx.client.jira().delete<unknown>(`/rest/api/3/permissionscheme/${encodeURIComponent(id)}`);
        return { deleted: id };
      },
    }),
    defineOp({
      op: "updatePermissionScheme",
      description: "Update a permission scheme (PUT-replace semantics; carries the existing name for partial updates).",
      destructive: true,
      legacyName: "schemes.updatePermissionScheme",
      input: {
        schemeId: permSchemeId,
        name: permSchemeName.optional(),
        description: permSchemeDescription.optional(),
        permissions: permSchemeGrants.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(
          `${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}?expand=all`,
        );
        const prev = before.data as { name?: string };
        // PUT /permissionscheme/{id} requires `name`. A description- or
        // permissions-only update must still carry the existing name or it 400s.
        const body: Record<string, unknown> = { name: input.name ?? prev.name };
        if (input.description !== undefined) body.description = input.description;
        if (input.permissions !== undefined) body.permissions = input.permissions;
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "permission_scheme", id: input.schemeId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting an update = PUT the captured `before` back. `before` is the
      // full scheme from GET ...?expand=all, so the grant list restores as a
      // PUT-replace.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: permission scheme id missing.");
        const before = entry.before as { name?: string; description?: string; permissions?: unknown[] } | null;
        // PUT /permissionscheme/{id} requires `name`, so a snapshot without one is unusable.
        if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` scheme name.");
        const body: Record<string, unknown> = { name: before.name };
        if (before.description !== undefined) body.description = before.description;
        if (before.permissions !== undefined) body.permissions = before.permissions;
        const resp = await ctx.client.jira().put<unknown>(`/rest/api/3/permissionscheme/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
    defineOp({
      op: "assignPermissionSchemeToProject",
      description: "Assign a permission scheme to a project (revertible: restores the prior assignment).",
      destructive: true,
      legacyName: "schemes.assignPermissionSchemeToProject",
      input: {
        projectKeyOrId: z.string().min(1).describe("Project to assign the scheme to"),
        schemeId: permSchemeId,
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const beforeResp = await c.get<unknown>(
          `${API}/project/${encodeURIComponent(input.projectKeyOrId)}/permissionscheme`,
        );
        const dry = meta.dryRun({
          target: { kind: "project_permission_scheme", id: input.projectKeyOrId },
          before: beforeResp.data,
          after: { id: input.schemeId },
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const before = entry.before as { id?: string } | null;
        const t = entry.target as { id?: string };
        if (!before?.id || !t.id) throw new Error("Cannot revert: missing before.id or target.id");
        await ctx.client
          .jira()
          .put<unknown>(`/rest/api/3/project/${encodeURIComponent(t.id)}/permissionscheme`, { id: before.id });
        return { restored_scheme_id: before.id };
      },
    }),
  ],
});

const notifSchemeName = z.string().min(1).describe("Notification scheme name");
const notifSchemeDescription = z.string().describe("Notification scheme description");
const notifSchemeId = z.string().min(1).describe("Notification scheme id");

const schemesManageNotification = defineOpTool({
  name: "schemes.manageNotification",
  description:
    "Manage notification schemes: create one — events settable only at create (createNotificationScheme) — or update name/description (updateNotificationScheme). Both revertible.",
  group: "write_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createNotificationScheme",
      description: "Create a notification scheme (notificationSchemeEvents settable only here, not via update).",
      destructive: true,
      legacyName: "schemes.createNotificationScheme",
      input: {
        name: notifSchemeName,
        description: notifSchemeDescription.optional(),
        notificationSchemeEvents: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe("Event → notification mappings"),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          name: input.name,
          description: input.description,
          notificationSchemeEvents: input.notificationSchemeEvents,
        };
        const dry = meta.dryRun({
          target: { kind: "notification_scheme", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: created scheme id missing.");
        await ctx.client.jira().delete<unknown>(`/rest/api/3/notificationscheme/${encodeURIComponent(id)}`);
        return { deleted: id };
      },
    }),
    defineOp({
      op: "updateNotificationScheme",
      description: "Update a notification scheme's name/description.",
      destructive: true,
      legacyName: "schemes.updateNotificationScheme",
      input: {
        schemeId: notifSchemeId,
        name: notifSchemeName.optional(),
        description: notifSchemeDescription.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
        const body: Record<string, unknown> = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.description !== undefined) body.description = input.description;
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "notification_scheme", id: input.schemeId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting an update = PUT the captured `before` back. PUT
      // /notificationscheme/{id} only accepts name + description, so only those
      // are sent.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: notification scheme id missing.");
        const before = entry.before as { name?: string; description?: string } | null;
        if (!before) throw new Error("Cannot revert: journal entry has no captured `before` scheme.");
        const body: Record<string, unknown> = {};
        if (before.name !== undefined) body.name = before.name;
        // PUT /notificationscheme/{id} is a PARTIAL update, and Jira omits
        // `description` entirely from GET when a scheme has none. Omitting it
        // here would leave a description the update ADDED in place — a silently
        // failed revert. Always send it, falling back to "" so the added
        // description is cleared.
        body.description = before.description ?? "";
        const resp = await ctx.client.jira().put<unknown>(`/rest/api/3/notificationscheme/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
  ],
});

const deleteSchemeId = z
  .string()
  .min(1)
  .describe("Scheme id — a PERMISSION scheme id or NOTIFICATION scheme id depending on the op");

const schemesDelete = defineOpTool({
  name: "schemes.delete",
  description:
    "Destructive scheme deletions: delete a permission scheme (deletePermissionScheme) or a notification scheme (deleteNotificationScheme). Irreversible.",
  group: "write_schemes",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "deletePermissionScheme",
      description: "Delete a permission scheme. Irreversible.",
      destructive: true,
      legacyName: "schemes.deletePermissionScheme",
      input: { schemeId: deleteSchemeId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(
          `${PERMISSION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}?expand=all`,
        );
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "permission_scheme", id: input.schemeId },
            before: before.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "deleteNotificationScheme",
      description: "Delete a notification scheme. Irreversible.",
      destructive: true,
      legacyName: "schemes.deleteNotificationScheme",
      input: { schemeId: deleteSchemeId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await c.get<unknown>(`${NOTIFICATION_SCHEME_PATH}/${encodeURIComponent(input.schemeId)}`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "notification_scheme", id: input.schemeId },
            before: before.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
  ],
});

export const schemeTools = (): AnyToolDef[] => [
  schemesReadAccess,
  schemesReadScreen,
  schemesReadConfig,
  schemesManagePermission,
  schemesManageNotification,
  schemesDelete,
];

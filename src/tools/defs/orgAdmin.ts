import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDryRunIfNotCommitted } from "../../consent/dryRun.js";
import { InsufficientPermissionsError } from "../../middleware/errorHandler.js";
import type { ToolContext } from "../types.js";

/**
 * Org/platform admin tools. Uses GOJIRA_ORG_ADMIN_TOKEN (env-side) and routes
 * through admin.atlassian.com/admin/v1. Gated on `GOJIRA_ENABLE_ORG_ADMIN=true`
 * plus the operator-declared caller allowlist (GOJIRA_ORG_ADMIN_ACCOUNT_IDS).
 *
 * Endpoint corrections here (group management under /directory/, user lifecycle
 * suspend-access/restore-access, audit-log epoch-millis timestamps) follow
 * Atlassian's org-admin API reference but could NOT be live-verified — the dev
 * environment has no org-admin API token. The group is off by default. Tools
 * that targeted non-existent endpoints (domain verification, org app management,
 * Rovo MCP settings) were removed rather than left to 404. The group list/get
 * endpoints in particular may need the /groups/search POST form depending on the
 * directory type; verify against your org before relying on them.
 */

function org(ctx: ToolContext): string {
  const o = ctx.config.orgAdmin.orgId;
  if (!o) throw new InsufficientPermissionsError("Org admin orgId not configured");
  return o;
}

/**
 * DELIBERATE: no org-admin op registers a reverter (defineOpTool throws if one
 * tries), and every mutating op here journals `revertible: false`.
 *
 * `gojira.revertOperation` lives in the `utility` permission group, so ANY
 * caller can invoke it. A reverter registered for an `admin_org` op would
 * therefore be an inverse org-admin mutation reachable WITHOUT the admin_org
 * gate (GOJIRA_ENABLE_ORG_ADMIN + the GOJIRA_ORG_ADMIN_ACCOUNT_IDS allowlist) —
 * a non-admin could restore a user an admin deactivated, re-add themselves to a
 * group they were removed from, or roll back an org policy. That is privilege
 * escalation, so these ops are undone only by calling the corresponding
 * org-admin op, which IS gated. Each `revertHint` names it.
 */

// Hoisted shared field schemas.
const accountId = z.string().min(1).describe("Managed account's Atlassian accountId");
const groupId = z.string().min(1).describe("Org directory group id");
const directoryCursor = z
  .string()
  .describe("Opaque pagination cursor from the SAME op's previous page (cursor spaces are per-op)");

const orgAdminReadDirectory = defineOpTool({
  name: "orgAdmin.readDirectory",
  description:
    "Read the org directory: list managed users (listOrgUsers), get one profile (getOrgUser), a user's groups (getUserGroups), the managed-accounts listing (listManagedAccounts), and list/get org groups (listGroups, getGroup).",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  ops: [
    defineOp({
      op: "listOrgUsers",
      description: "Paginated list of managed accounts in the org.",
      legacyName: "orgAdmin.listOrgUsers",
      input: { cursor: directoryCursor.optional() },
      handler: async (input, ctx) => {
        const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/users${q}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getOrgUser",
      description: "Get a managed account's profile.",
      legacyName: "orgAdmin.getOrgUser",
      input: { accountId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .admin()
          .get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getUserGroups",
      description: "List groups for a managed account.",
      legacyName: "orgAdmin.getUserGroups",
      input: { accountId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .admin()
          .get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}/groups`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listManagedAccounts",
      description: "List all managed accounts in the org (paged).",
      legacyName: "orgAdmin.listManagedAccounts",
      input: { cursor: directoryCursor.optional() },
      handler: async (input, ctx) => {
        const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/managed-accounts${q}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listGroups",
      description: "List org-level groups.",
      legacyName: "orgAdmin.listGroups",
      input: { cursor: directoryCursor.optional() },
      handler: async (input, ctx) => {
        const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/directory/groups${q}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getGroup",
      description: "Get a group by id.",
      legacyName: "orgAdmin.getGroup",
      input: { groupId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .admin()
          .get<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}`);
        return resp.data;
      },
    }),
  ],
});

const orgAdminReadOrg = defineOpTool({
  name: "orgAdmin.readOrg",
  description:
    "Read org-level data: security/data policies (getOrgPolicies), the audit log with filters (queryAuditLog), or verified domains (listVerifiedDomains).",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  ops: [
    defineOp({
      op: "getOrgPolicies",
      description: "List org policies (data residency, IP allowlists, etc.), optionally filtered by type.",
      legacyName: "orgAdmin.getOrgPolicies",
      input: { type: z.string().optional().describe("Policy type filter") },
      handler: async (input, ctx) => {
        const q = input.type ? `?type=${encodeURIComponent(input.type)}` : "";
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/policies${q}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "queryAuditLog",
      description: "Query the org audit log with optional filters (from/to accept ISO-8601 or epoch millis).",
      legacyName: "orgAdmin.queryAuditLog",
      input: {
        from: z.string().optional().describe("ISO-8601 datetime or UNIX epoch millis; sent as epoch millis."),
        to: z.string().optional().describe("ISO-8601 datetime or UNIX epoch millis; sent as epoch millis."),
        actor: z.string().optional(),
        action: z.string().optional(),
        product: z.string().optional(),
        cursor: z.string().optional().describe("Audit-log pagination cursor"),
        limit: z.number().int().positive().max(500).default(100).optional(),
      },
      handler: async (input, ctx) => {
        // The events API requires `from`/`to` as UNIX epoch MILLIS, not ISO.
        const toEpochMs = (v: string): string => {
          const n = Number(v);
          if (Number.isFinite(n)) return String(Math.trunc(n));
          const t = Date.parse(v);
          return Number.isFinite(t) ? String(t) : v;
        };
        const p = new URLSearchParams();
        if (input.from) p.set("from", toEpochMs(input.from));
        if (input.to) p.set("to", toEpochMs(input.to));
        if (input.actor) p.set("actor", input.actor);
        if (input.action) p.set("action", input.action);
        if (input.product) p.set("product", input.product);
        if (input.cursor) p.set("cursor", input.cursor);
        p.set("limit", String(input.limit ?? 100));
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/events?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listVerifiedDomains",
      description: "List verified domains owned by the org. (Domain verification itself is a UI/DNS flow.)",
      legacyName: "orgAdmin.listVerifiedDomains",
      handler: async (_input, ctx) => {
        const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/domains`);
        return resp.data;
      },
    }),
  ],
});

const orgAdminManageUser = defineOpTool({
  name: "orgAdmin.manageUser",
  description:
    "Manage org users: provision a new user (provisionUser), deactivate a managed account (deactivateUser), or restore one (restoreUser). None auto-revertible — each is undone by its gated counterpart.",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  ops: [
    defineOp({
      op: "provisionUser",
      description: "Provision a new user.",
      destructive: true,
      legacyName: "orgAdmin.provisionUser",
      input: {
        email: z.string().email().describe("New user's email"),
        displayName: z.string().min(1),
        profile: z.record(z.string(), z.unknown()).optional().describe("Extra profile fields"),
      },
      handler: async (input, ctx, meta) => {
        const body = { email: input.email, displayName: input.displayName, ...(input.profile ?? {}) };
        const dry = meta.dryRun({
          target: { kind: "org_user", id: input.email },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_user", id: input.email },
          before: null,
          request: body as Record<string, unknown>,
          revertible: false,
          run: async () => {
            const resp = await ctx.client.admin().post<unknown>(`/orgs/${org(ctx)}/users`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, user: entry.after };
      },
    }),
    defineOp({
      op: "deactivateUser",
      description: "Deactivate a managed account. Undo by calling restoreUser (gated) — not revertOperation.",
      destructive: true,
      legacyName: "orgAdmin.deactivateUser",
      input: { accountId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.admin();
        const before = await c.get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
        const dry = meta.dryRun({
          target: { kind: "org_user", id: input.accountId },
          before: before.data,
          after: { ...(before.data as object), status: "deactivated" },
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_user", id: input.accountId },
          before: before.data,
          request: { accountId: input.accountId } as Record<string, unknown>,
          revertible: false,
          revertHint:
            "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.manageUser restoreUser with the same accountId.",
          run: async () => {
            await c.post<unknown>(
              `/orgs/${org(ctx)}/directory/users/${encodeURIComponent(input.accountId)}/suspend-access`,
            );
            return { deactivated: input.accountId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
    defineOp({
      op: "restoreUser",
      description: "Restore a previously deactivated managed account.",
      destructive: true,
      legacyName: "orgAdmin.restoreUser",
      input: { accountId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.admin();
        const before = await c.get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
        const dry = meta.dryRun({
          target: { kind: "org_user", id: input.accountId },
          before: before.data,
          after: { ...(before.data as object), status: "active" },
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_user", id: input.accountId },
          before: before.data,
          request: { accountId: input.accountId } as Record<string, unknown>,
          revertible: false,
          revertHint:
            "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.manageUser deactivateUser with the same accountId.",
          run: async () => {
            await c.post<unknown>(
              `/orgs/${org(ctx)}/directory/users/${encodeURIComponent(input.accountId)}/restore-access`,
            );
            return { restored: input.accountId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
  ],
});

const orgAdminManageGroup = defineOpTool({
  name: "orgAdmin.manageGroup",
  description:
    "Org group additions: create an org-level group (createGroup) or add a user to a group (addUserToGroup). Undo via orgAdmin.delete (gated) — not revertOperation.",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  ops: [
    defineOp({
      op: "createGroup",
      description: "Create an org-level group.",
      destructive: true,
      legacyName: "orgAdmin.createGroup",
      input: { name: z.string().min(1).describe("Group name"), description: z.string().optional() },
      handler: async (input, ctx, meta) => {
        const body = { name: input.name, description: input.description };
        const dry = meta.dryRun({
          target: { kind: "org_group", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_group", name: input.name },
          before: null,
          request: body as Record<string, unknown>,
          revertible: false,
          revertHint:
            "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.delete deleteGroup with the created group id (see the journal `after` payload).",
          run: async () => {
            const resp = await ctx.client.admin().post<unknown>(`/orgs/${org(ctx)}/directory/groups`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, group: entry.after };
      },
    }),
    defineOp({
      op: "addUserToGroup",
      description: "Add a user to a group.",
      destructive: true,
      legacyName: "orgAdmin.addUserToGroup",
      input: { accountId, groupId },
      handler: async (input, ctx, meta) => {
        const dry = meta.dryRun({
          target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
          before: null,
          after: { added: true },
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
          before: null,
          request: { accountId: input.accountId, groupId: input.groupId } as Record<string, unknown>,
          revertible: false,
          revertHint:
            "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.delete removeUserFromGroup with the same accountId and groupId.",
          run: async () => {
            await ctx.client
              .admin()
              .post<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}/memberships`, {
                account_id: input.accountId,
              });
            return { added: true };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
  ],
});

const orgAdminDelete = defineOpTool({
  name: "orgAdmin.delete",
  description:
    "Destructive org removals: remove a user from a group (removeUserFromGroup) or delete an org-level group (deleteGroup). Undo via orgAdmin.manageGroup (gated) — not revertOperation.",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  ops: [
    defineOp({
      op: "removeUserFromGroup",
      description: "Remove a user from a group.",
      destructive: true,
      legacyName: "orgAdmin.removeUserFromGroup",
      input: { accountId, groupId },
      handler: async (input, ctx, meta) => {
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
            before: { accountId: input.accountId, groupId: input.groupId },
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
          before: { accountId: input.accountId, groupId: input.groupId },
          request: { accountId: input.accountId, groupId: input.groupId } as Record<string, unknown>,
          revertible: false,
          revertHint:
            "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.manageGroup addUserToGroup with the same accountId and groupId.",
          run: async () => {
            await ctx.client
              .admin()
              .delete<unknown>(
                `/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}/memberships/${encodeURIComponent(input.accountId)}`,
              );
            return { removed: true };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
    defineOp({
      op: "deleteGroup",
      description: "Delete an org-level group.",
      destructive: true,
      legacyName: "orgAdmin.deleteGroup",
      input: { groupId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.admin();
        const before = await c.get<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "org_group", id: input.groupId },
            before: before.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "org_group", id: input.groupId },
          before: before.data,
          request: { groupId: input.groupId } as Record<string, unknown>,
          revertible: false,
          run: async () => {
            await c.delete<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}`);
            return { deleted: input.groupId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
  ],
});

// Keeper: its free-form `body` record stays isolated from the structured
// directory ops.
const orgAdminSetOrgPolicy = defineTool({
  name: "orgAdmin.setOrgPolicy",
  description: "Set or replace an org policy.",
  group: "admin_org",
  authMethod: "org_admin",
  needsCloudId: false,
  destructive: true,
  input: {
    policyId: z.string().min(1),
    body: z.record(z.string(), z.unknown()),
    commit: z.boolean().optional(),
  },
  handler: async (input, ctx) => {
    const c = ctx.client.admin();
    const before = await c.get<unknown>(`/orgs/${org(ctx)}/policies/${encodeURIComponent(input.policyId)}`);
    const dry = buildDryRunIfNotCommitted(input, {
      tool: "orgAdmin.setOrgPolicy",
      target: { kind: "org_policy", id: input.policyId },
      before: before.data,
      after: input.body,
    });
    if (dry) return dry;
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
      target: { kind: "org_policy", id: input.policyId },
      before: before.data,
      request: { policyId: input.policyId, body: input.body } as Record<string, unknown>,
      revertible: false,
      revertHint:
        "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.setOrgPolicy with the same policyId and the captured `before` payload as `body`.",
      run: async () => {
        const resp = await c.put<unknown>(`/orgs/${org(ctx)}/policies/${encodeURIComponent(input.policyId)}`, input.body);
        return resp.data;
      },
    });
    return { ok: true, journal_id: entry.opId };
  },
});

// Removed (no public org-admin REST API — were guaranteed 404s):
//  - orgAdmin.verifyDomain: domains are read-only via the API
//    (GET /domains). Verification is a UI/DNS flow. listVerifiedDomains kept.
//  - orgAdmin.listInstalledApps / getApp / removeApp: there is no org-level
//    Marketplace app-management REST API.
//  - orgAdmin.getRovoMcpSettings / setRovoMcpAllowedDomains /
//    setRovoMcpApiTokenAuth: Rovo MCP admin settings have no public API (UI only).

export const orgAdminTools = (): AnyToolDef[] => [
  orgAdminReadDirectory,
  orgAdminReadOrg,
  orgAdminManageUser,
  orgAdminManageGroup,
  orgAdminDelete,
  orgAdminSetOrgPolicy,
];

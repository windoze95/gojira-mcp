import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { InsufficientPermissionsError } from "../../middleware/errorHandler.js";

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

function org(ctx: import("../types.js").ToolContext): string {
  const o = ctx.config.orgAdmin.orgId;
  if (!o) throw new InsufficientPermissionsError("Org admin orgId not configured");
  return o;
}

/**
 * DELIBERATE: no org-admin tool registers a reverter, and every mutating tool
 * here journals `revertible: false`.
 *
 * `gojira.revertOperation` lives in the `utility` permission group, so ANY
 * caller can invoke it. A reverter registered for an `admin_org` tool would
 * therefore be an inverse org-admin mutation reachable WITHOUT the admin_org
 * gate (GOJIRA_ENABLE_ORG_ADMIN + the GOJIRA_ORG_ADMIN_ACCOUNT_IDS allowlist) —
 * a non-admin could restore a user an admin deactivated, re-add themselves to a
 * group they were removed from, or roll back an org policy. That is privilege
 * escalation, so these ops are undone only by calling the corresponding
 * org-admin tool, which IS gated. Each `revertHint` names that tool.
 */

export const orgAdminTools = (): AnyToolDef[] => [
  // ---- Users ----
  defineTool({
    name: "orgAdmin.listOrgUsers",
    description: "Paginated list of managed accounts in the org.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { cursor: z.string().optional() },
    handler: async (input, ctx) => {
      const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/users${q}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.getOrgUser",
    description: "Get a managed account's profile.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { accountId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .admin()
        .get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.provisionUser",
    description: "Provision a new user. Requires `commit:true`.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: {
      email: z.string().email(),
      displayName: z.string().min(1),
      profile: z.record(z.string(), z.unknown()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { email: input.email, displayName: input.displayName, ...(input.profile ?? {}) };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "orgAdmin.provisionUser",
        target: { kind: "org_user", id: input.email },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.provisionUser",
        cloudId: null,
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
  defineTool({
    name: "orgAdmin.deactivateUser",
    description: "Deactivate a managed account. Reversible via restoreUser.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { accountId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.admin();
      const before = await c.get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "orgAdmin.deactivateUser",
        target: { kind: "org_user", id: input.accountId },
        before: before.data,
        after: { ...(before.data as object), status: "deactivated" },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.deactivateUser",
        cloudId: null,
        target: { kind: "org_user", id: input.accountId },
        before: before.data,
        request: { accountId: input.accountId } as Record<string, unknown>,
        revertible: false,
        revertHint:
          "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.restoreUser with the same accountId.",
        run: async () => {
          await c.post<unknown>(`/orgs/${org(ctx)}/directory/users/${encodeURIComponent(input.accountId)}/suspend-access`);
          return { deactivated: input.accountId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "orgAdmin.restoreUser",
    description: "Restore a previously deactivated managed account.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { accountId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.admin();
      const before = await c.get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "orgAdmin.restoreUser",
        target: { kind: "org_user", id: input.accountId },
        before: before.data,
        after: { ...(before.data as object), status: "active" },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.restoreUser",
        cloudId: null,
        target: { kind: "org_user", id: input.accountId },
        before: before.data,
        request: { accountId: input.accountId } as Record<string, unknown>,
        revertible: false,
        revertHint:
          "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.deactivateUser with the same accountId.",
        run: async () => {
          await c.post<unknown>(`/orgs/${org(ctx)}/directory/users/${encodeURIComponent(input.accountId)}/restore-access`);
          return { restored: input.accountId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // ---- Group membership ----
  defineTool({
    name: "orgAdmin.getUserGroups",
    description: "List groups for a managed account.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { accountId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .admin()
        .get<unknown>(`/orgs/${org(ctx)}/users/${encodeURIComponent(input.accountId)}/groups`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.addUserToGroup",
    description: "Add a user to a group.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { accountId: z.string().min(1), groupId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "orgAdmin.addUserToGroup",
        target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
        before: null,
        after: { added: true },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.addUserToGroup",
        cloudId: null,
        target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
        before: null,
        request: { accountId: input.accountId, groupId: input.groupId } as Record<string, unknown>,
        revertible: false,
        revertHint:
          "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.removeUserFromGroup with the same accountId and groupId.",
        run: async () => {
          await ctx.client
            .admin()
            .post<unknown>(
              `/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}/memberships`,
              { account_id: input.accountId },
            );
          return { added: true };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "orgAdmin.removeUserFromGroup",
    description: "Remove a user from a group.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { accountId: z.string().min(1), groupId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "orgAdmin.removeUserFromGroup",
          target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
          before: { accountId: input.accountId, groupId: input.groupId },
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.removeUserFromGroup",
        cloudId: null,
        target: { kind: "org_group_membership", id: input.groupId, parent: input.accountId },
        before: { accountId: input.accountId, groupId: input.groupId },
        request: { accountId: input.accountId, groupId: input.groupId } as Record<string, unknown>,
        revertible: false,
        revertHint:
          "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.addUserToGroup with the same accountId and groupId.",
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

  // ---- Groups ----
  defineTool({
    name: "orgAdmin.listGroups",
    description: "List org-level groups.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { cursor: z.string().optional() },
    handler: async (input, ctx) => {
      const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/directory/groups${q}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.getGroup",
    description: "Get a group by id.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { groupId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.createGroup",
    description: "Create an org-level group.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { name: z.string().min(1), description: z.string().optional(), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const body = { name: input.name, description: input.description };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "orgAdmin.createGroup",
        target: { kind: "org_group", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.createGroup",
        cloudId: null,
        target: { kind: "org_group", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: false,
        revertHint:
          "Not auto-revertible (revertOperation is not org-admin gated). Call orgAdmin.deleteGroup with the created group id (see the journal `after` payload).",
        run: async () => {
          const resp = await ctx.client.admin().post<unknown>(`/orgs/${org(ctx)}/directory/groups`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, group: entry.after };
    },
  }),
  defineTool({
    name: "orgAdmin.deleteGroup",
    description: "Delete an org-level group.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    destructive: true,
    input: { groupId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.admin();
      const before = await c.get<unknown>(`/orgs/${org(ctx)}/directory/groups/${encodeURIComponent(input.groupId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "orgAdmin.deleteGroup",
          target: { kind: "org_group", id: input.groupId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "orgAdmin.deleteGroup",
        cloudId: null,
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

  // ---- Org policies ----
  defineTool({
    name: "orgAdmin.getOrgPolicies",
    description: "List org policies (data residency, IP allowlists, etc.).",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { type: z.string().optional() },
    handler: async (input, ctx) => {
      const q = input.type ? `?type=${encodeURIComponent(input.type)}` : "";
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/policies${q}`);
      return resp.data;
    },
  }),
  defineTool({
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
        accountId: ctx.accountId,
        tool: "orgAdmin.setOrgPolicy",
        cloudId: null,
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
  }),

  // ---- Misc ----
  defineTool({
    name: "orgAdmin.listManagedAccounts",
    description: "List all managed accounts in the org (paged).",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: { cursor: z.string().optional() },
    handler: async (input, ctx) => {
      const q = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/managed-accounts${q}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "orgAdmin.queryAuditLog",
    description: "Query org audit log with optional filters.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    input: {
      from: z.string().optional().describe("ISO-8601 datetime or UNIX epoch millis; sent as epoch millis."),
      to: z.string().optional().describe("ISO-8601 datetime or UNIX epoch millis; sent as epoch millis."),
      actor: z.string().optional(),
      action: z.string().optional(),
      product: z.string().optional(),
      cursor: z.string().optional(),
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
  defineTool({
    name: "orgAdmin.listVerifiedDomains",
    description: "List verified domains owned by the org.",
    group: "admin_org",
    authMethod: "org_admin",
    needsCloudId: false,
    handler: async (_input, ctx) => {
      const resp = await ctx.client.admin().get<unknown>(`/orgs/${org(ctx)}/domains`);
      return resp.data;
    },
  }),
  // Removed (no public org-admin REST API — were guaranteed 404s):
  //  - orgAdmin.verifyDomain: domains are read-only via the API
  //    (GET /domains). Verification is a UI/DNS flow. listVerifiedDomains kept.
  //  - orgAdmin.listInstalledApps / getApp / removeApp: there is no org-level
  //    Marketplace app-management REST API.
  //  - orgAdmin.getRovoMcpSettings / setRovoMcpAllowedDomains /
  //    setRovoMcpApiTokenAuth: Rovo MCP admin settings have no public API (UI only).
];

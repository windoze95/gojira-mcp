import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * JSM admin tools — API token side-channel, hitting the JSM Cloud public REST
 * API (/rest/servicedeskapi) on the user's site via apiTokenJira().
 *
 * Scope note: the public servicedeskapi surface is deliberately narrow. Several
 * "admin" capabilities have NO public REST endpoint and are therefore NOT
 * exposed here (doing so previously produced tools that 404'd at commit time):
 *   - SLA CONFIGURATION (create/update) — UI only. Only per-request SLA state is
 *     readable (getRequestSla below).
 *   - QUEUE create/update/delete — queues are read-only in the API.
 *   - Request type UPDATE and field-set replacement — read + create + delete only.
 *   - Request-type GROUP assignment — read only.
 *   - Portal announcements / branding — no public API.
 *   - JSM Forms — served by a separate Forms API (api.atlassian.com/jira/forms/*),
 *     not servicedeskapi.
 *   - Knowledge-base LINKING — UI only; only article SEARCH is exposed.
 */

const SD = "/rest/servicedeskapi";

export const jsmTools = (): AnyToolDef[] => [
  // --- Service desks ---
  defineTool({
    name: "jsm.listServiceDesks",
    description: "List all JSM service desks visible to the API-token caller.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      start: z.number().int().nonnegative().default(0).optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
      const resp = await ctx.client.apiTokenJira().get<unknown>(`${SD}/servicedesk?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getServiceDesk",
    description: "Get a single service desk by id.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.apiTokenJira().get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}`);
      return resp.data;
    },
  }),

  // --- Request types (read + create + delete; no update/field-replace in the API) ---
  defineTool({
    name: "jsm.listRequestTypes",
    description: "List request types in a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), groupId: z.string().optional() },
    handler: async (input, ctx) => {
      const p = new URLSearchParams();
      if (input.groupId) p.set("groupId", input.groupId);
      const path = `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype${
        p.toString() ? `?${p.toString()}` : ""
      }`;
      const resp = await ctx.client.apiTokenJira().get<unknown>(path);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getRequestType",
    description: "Get a request type by id.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), requestTypeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getRequestTypeFields",
    description: "Get the field set associated with a request type.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), requestTypeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(
          `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/field`,
        );
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getRequestTypeGroups",
    description: "List the request-type groups of a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttypegroup`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.createRequestType",
    description: "Create a request type. Destructive — requires `commit:true`.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      issueTypeId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      helpText: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        issueTypeId: input.issueTypeId,
        name: input.name,
        description: input.description,
        helpText: input.helpText,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.createRequestType",
        target: { kind: "request_type", name: input.name, parent: input.serviceDeskId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.createRequestType",
        cloudId: ctx.cloudId,
        target: { kind: "request_type", name: input.name, parent: input.serviceDeskId },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created request type id.",
        deriveTargetId: (after) => (after as { id?: string })?.id,
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<{ id: string }>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, requestType: entry.after };
    },
  }),
  defineTool({
    name: "jsm.deleteRequestType",
    description: "Delete a request type. Irreversible.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      requestTypeId: z.string().min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
      );
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "jsm.deleteRequestType",
          target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.deleteRequestType",
        cloudId: ctx.cloudId,
        target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
        before: before.data,
        request: { ...input } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
          );
          return { deleted: input.requestTypeId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Queues (read-only in the public API) ---
  defineTool({
    name: "jsm.listQueues",
    description: "List the queues of a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getQueue",
    description: "Get a single queue by id.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), queueId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getQueueIssues",
    description: "Get the issues currently visible in a queue.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      serviceDeskId: z.string().min(1),
      queueId: z.string().min(1),
      start: z.number().int().nonnegative().default(0).optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        start: String(input.start ?? 0),
        limit: String(input.limit ?? 50),
      });
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(
          `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}/issue?${p.toString()}`,
        );
      return resp.data;
    },
  }),

  // --- SLA (read-only, per request — SLA CONFIG has no public API) ---
  defineTool({
    name: "jsm.getRequestSla",
    description:
      "Get the SLA state (cycles, breach status, remaining time) for a single customer request. " +
      "Note: SLA *configuration* is not exposed by the public API; only per-request SLA state is.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      issueIdOrKey: z.string().min(1).describe("The request/issue id or key, e.g. ISD-42."),
      start: z.number().int().nonnegative().default(0).optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/request/${encodeURIComponent(input.issueIdOrKey)}/sla?${p.toString()}`);
      return resp.data;
    },
  }),

  // --- Organizations & customers ---
  defineTool({
    name: "jsm.listJsmOrganizations",
    description: "List organizations available in a service desk (or globally if serviceDeskId omitted).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      serviceDeskId: z.string().optional(),
      start: z.number().int().nonnegative().default(0).optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
      const path = input.serviceDeskId
        ? `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/organization?${p.toString()}`
        : `${SD}/organization?${p.toString()}`;
      const resp = await ctx.client.apiTokenJira().get<unknown>(path);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.addCustomersToOrganization",
    description: "Add customers (by accountId or email) to an organization.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      organizationId: z.string().min(1),
      usernames: z.array(z.string()).optional(),
      accountIds: z.array(z.string()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body: Record<string, unknown> = {};
      if (input.usernames?.length) body.usernames = input.usernames;
      if (input.accountIds?.length) body.accountIds = input.accountIds;
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.addCustomersToOrganization",
        target: { kind: "jsm_organization", id: input.organizationId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.addCustomersToOrganization",
        cloudId: ctx.cloudId,
        target: { kind: "jsm_organization", id: input.organizationId },
        before: null,
        // organizationId is the path param, `body` the customer list — the reverter needs both.
        request: { organizationId: input.organizationId, ...body },
        revertible: true,
        revertHint: "DELETE the same customers from the organization (jsm.removeCustomersFromOrganization).",
        run: async () => {
          await ctx.client
            .apiTokenJira()
            .post<unknown>(`${SD}/organization/${encodeURIComponent(input.organizationId)}/user`, body);
          return { added: true, ...body };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "jsm.removeCustomersFromOrganization",
    description: "Remove customers (by accountId or email) from an organization.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      organizationId: z.string().min(1),
      usernames: z.array(z.string()).optional(),
      accountIds: z.array(z.string()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body: Record<string, unknown> = {};
      if (input.usernames?.length) body.usernames = input.usernames;
      if (input.accountIds?.length) body.accountIds = input.accountIds;
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "jsm.removeCustomersFromOrganization",
          target: { kind: "jsm_organization", id: input.organizationId },
          before: body,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.removeCustomersFromOrganization",
        cloudId: ctx.cloudId,
        target: { kind: "jsm_organization", id: input.organizationId },
        before: body,
        // organizationId is the path param, `body` the customer list — the reverter needs both.
        request: { organizationId: input.organizationId, ...body },
        revertible: true,
        revertHint: "Re-add the customers (jsm.addCustomersToOrganization).",
        run: async () => {
          await ctx.client
            .apiTokenJira()
            .delete<unknown>(`${SD}/organization/${encodeURIComponent(input.organizationId)}/user`, { data: body });
          return { removed: true, ...body };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Knowledge base (article SEARCH only; linking is UI-only) ---
  defineTool({
    name: "jsm.searchKnowledgeBaseArticles",
    description: "Search the knowledge-base articles surfaced by a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      serviceDeskId: z.string().min(1),
      query: z.string().min(1),
      highlight: z.boolean().optional(),
      start: z.number().int().nonnegative().default(0).optional(),
      limit: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        query: input.query,
        start: String(input.start ?? 0),
        limit: String(input.limit ?? 50),
      });
      if (input.highlight !== undefined) p.set("highlight", String(input.highlight));
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/knowledgebase/article?${p.toString()}`);
      return resp.data;
    },
  }),
];

// Revert a created request type by deleting it. The created id is persisted onto
// the journal target via deriveTargetId (see wrapHandler.journalOp).
reverters.register("jsm.createRequestType", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const t = entry.target as { id?: string; parent?: string };
  if (!t.id || !t.parent) throw new Error("Cannot revert: request type id/serviceDeskId missing from target.");
  await ctx.client
    .apiTokenJira()
    .delete<unknown>(`${SD}/servicedesk/${encodeURIComponent(t.parent)}/requesttype/${encodeURIComponent(t.id)}`);
  return { deleted: t.id };
});

/**
 * Both org-membership tools call the SAME endpoint with opposite verbs
 * (POST adds, DELETE removes) and the same {usernames?, accountIds?} body, so
 * each is the other's inverse. Rebuild that call from the journal entry.
 */
function organizationUserCall(entry: import("../../operations/journal.js").JournalEntry): {
  path: string;
  body: Record<string, unknown>;
} {
  const req = (entry.request ?? {}) as { organizationId?: string; usernames?: string[]; accountIds?: string[] };
  const organizationId = req.organizationId ?? (entry.target as { id?: string }).id;
  if (!organizationId) throw new Error("Cannot revert: organizationId missing from the journal entry.");
  const body: Record<string, unknown> = {};
  if (req.usernames?.length) body.usernames = req.usernames;
  if (req.accountIds?.length) body.accountIds = req.accountIds;
  if (Object.keys(body).length === 0) {
    throw new Error("Cannot revert: no customers recorded on the journal entry.");
  }
  return { path: `${SD}/organization/${encodeURIComponent(organizationId)}/user`, body };
}

// Reverting an add = remove exactly the customers that were added.
reverters.register("jsm.addCustomersToOrganization", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const { path, body } = organizationUserCall(entry);
  await ctx.client.apiTokenJira().delete<unknown>(path, { data: body });
  return { removed: true, ...body };
});

// Reverting a remove = re-add exactly the customers that were removed.
reverters.register("jsm.removeCustomersFromOrganization", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const { path, body } = organizationUserCall(entry);
  await ctx.client.apiTokenJira().post<unknown>(path, body);
  return { added: true, ...body };
});

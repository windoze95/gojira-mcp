import { z } from "zod";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import type { AtlassianClient } from "../../atlassian/client.js";
import type { JournalEntry } from "../../operations/journal.js";
import type { ToolContext } from "../types.js";

/**
 * JSM admin tools — API token side-channel, hitting the JSM Cloud public REST
 * API (/rest/servicedeskapi) on the user's site via apiTokenJira().
 *
 * Scope note: the public servicedeskapi surface is deliberately narrow. Several
 * "admin" capabilities have NO public REST endpoint and are therefore NOT
 * exposed here (doing so previously produced tools that 404'd at commit time):
 *   - SLA CONFIGURATION (create/update) — UI only. Only per-request SLA state is
 *     readable (getRequestSla).
 *   - QUEUE create/update/delete — queues are read-only in the API.
 *   - Request type UPDATE and field-set replacement — read + create + delete only.
 *   - Request-type GROUP assignment — read only.
 *   - Portal announcements / branding — no public API.
 *   - JSM Forms — served by a separate Forms API (api.atlassian.com/jira/forms/*),
 *     not servicedeskapi; see forms.ts.
 *   - Knowledge-base LINKING — UI only; only article SEARCH is exposed.
 */

const SD = "/rest/servicedeskapi";

/** Page size and a hard page cap for the org-membership walk (a runaway pager must terminate). */
const MEMBER_PAGE_SIZE = 50;
const MEMBER_MAX_PAGES = 200;

/**
 * Snapshot an organization's current members (accountIds), following pagination.
 *
 * Membership mutations are only honestly revertible if we know who was ALREADY
 * a member. POST /organization/{id}/user is a no-op for a customer that is
 * already in the org, so "undo the add" must evict ONLY the customers the call
 * actually created — evicting the rest would remove state the call never
 * created. The membership is therefore snapshotted before and after the
 * mutation, and the diff is what a revert acts on. The diff (rather than
 * "submitted minus already-present") is also what makes an add keyed by
 * `usernames` revertible at all: emails do not identify a member — Atlassian
 * privacy settings routinely redact `emailAddress` from the membership list —
 * whereas the accountIds that appear/disappear between the two snapshots do.
 */
async function fetchOrganizationMembers(c: AtlassianClient, organizationId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < MEMBER_MAX_PAGES; page++) {
    const p = new URLSearchParams({
      start: String(page * MEMBER_PAGE_SIZE),
      limit: String(MEMBER_PAGE_SIZE),
    });
    const resp = await c.get<{ values?: Array<{ accountId?: string }>; isLastPage?: boolean }>(
      `${SD}/organization/${encodeURIComponent(organizationId)}/user?${p.toString()}`,
    );
    const values = resp.data.values ?? [];
    for (const u of values) if (u.accountId) ids.push(u.accountId);
    if (resp.data.isLastPage === true || values.length < MEMBER_PAGE_SIZE) break;
  }
  return ids;
}

/**
 * `null` means the membership could not be read (endpoint denied to this token,
 * org gone, transient failure). Never guess in that case: a null snapshot makes
 * the op non-revertible rather than one that reverts state it did not create.
 * Used post-mutation too — the mutation already landed, so a failed snapshot
 * must not turn a successful op into a journaled failure.
 */
async function tryFetchOrganizationMembers(c: AtlassianClient, organizationId: string): Promise<string[] | null> {
  try {
    return await fetchOrganizationMembers(c, organizationId);
  } catch {
    return null;
  }
}

/** accountIds present in `a` but not in `b`. */
function membersDiff(a: string[], b: string[]): string[] {
  const inB = new Set(b);
  return a.filter((id) => !inB.has(id));
}

const MEMBERSHIP_SNAPSHOT_UNAVAILABLE =
  "The organization's membership could not be read, so a revert cannot tell which customers this call actually changed.";

/**
 * Both org-membership ops call the SAME endpoint with opposite verbs (POST
 * adds, DELETE removes), so each is the other's inverse — but the inverse must
 * be applied to the customers the op ACTUALLY moved, not to the ones it was
 * asked to move. Submitting a customer who is already a member is a no-op for
 * them; reverting the whole submitted list would then evict someone the op never
 * added, i.e. remove state it did not create. `after.added` / `after.removed` is
 * the set that really moved — the diff of the membership snapshots taken around
 * the mutation (see fetchOrganizationMembers) — and reverting by accountId works
 * even when the original call named its customers by email.
 */
function organizationRevertCall(entry: JournalEntry, moved: "added" | "removed"): { path: string; accountIds: string[] } {
  const req = (entry.request ?? {}) as { organizationId?: string };
  const organizationId = req.organizationId ?? (entry.target as { id?: string }).id;
  if (!organizationId) throw new Error("Cannot revert: organizationId missing from the journal entry.");
  const accountIds = (entry.after as Record<string, unknown> | null)?.[moved];
  if (!Array.isArray(accountIds)) {
    throw new Error(
      `Cannot revert: the journal entry records no \`${moved}\` set — the organization's membership was not readable ` +
        `around the call, so which customers it actually ${moved} is unknown.`,
    );
  }
  return { path: `${SD}/organization/${encodeURIComponent(organizationId)}/user`, accountIds: accountIds as string[] };
}

// Hoisted shared field schemas.
const serviceDeskId = z.string().min(1).describe("Service desk id");
const requestTypeId = z.string().min(1).describe("Request type id");
const queueId = z.string().min(1).describe("Queue id");
const pageStart = z.number().int().nonnegative().default(0).describe("Page offset");
const pageLimit = z.number().int().positive().max(100).default(50).describe("Page size");
const organizationId = z.string().min(1).describe("JSM organization id");
const customerUsernames = z.array(z.string()).describe("Customer emails");
const customerAccountIds = z.array(z.string()).describe("Customer accountIds");

const jsmReadServiceDesk = defineOpTool({
  name: "jsm.readServiceDesk",
  description:
    "Read JSM service desks and request types: list service desks (listServiceDesks), get one (getServiceDesk), list a desk's request types (listRequestTypes), get one (getRequestType), its field set (getRequestTypeFields), or the desk's request-type groups (getRequestTypeGroups).",
  group: "read_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listServiceDesks",
      description: "List all JSM service desks visible to the API-token caller.",
      legacyName: "jsm.listServiceDesks",
      input: { start: pageStart.optional(), limit: pageLimit.optional() },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
        const resp = await ctx.client.apiTokenJira().get<unknown>(`${SD}/servicedesk?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getServiceDesk",
      description: "Get a single service desk by id.",
      legacyName: "jsm.getServiceDesk",
      input: { serviceDeskId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listRequestTypes",
      description: "List request types in a service desk, optionally scoped to a request-type group.",
      legacyName: "jsm.listRequestTypes",
      input: { serviceDeskId, groupId: z.string().optional().describe("Request-type group filter") },
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
    defineOp({
      op: "getRequestType",
      description: "Get a request type by id.",
      legacyName: "jsm.getRequestType",
      input: { serviceDeskId, requestTypeId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
          );
        return resp.data;
      },
    }),
    defineOp({
      op: "getRequestTypeFields",
      description: "Get the field set associated with a request type.",
      legacyName: "jsm.getRequestTypeFields",
      input: { serviceDeskId, requestTypeId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/field`,
          );
        return resp.data;
      },
    }),
    defineOp({
      op: "getRequestTypeGroups",
      description: "List the request-type groups of a service desk.",
      legacyName: "jsm.getRequestTypeGroups",
      input: { serviceDeskId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttypegroup`);
        return resp.data;
      },
    }),
  ],
});

const jsmReadSupport = defineOpTool({
  name: "jsm.readSupport",
  description:
    "Read JSM operational data: list a desk's queues (listQueues), get one (getQueue), its visible issues (getQueueIssues), the SLA state of a request (getRequestSla — keyed by ISSUE, not desk), JSM organizations (listJsmOrganizations — global when serviceDeskId omitted), or search knowledge-base articles (searchKnowledgeBaseArticles).",
  group: "read_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listQueues",
      description: "List the queues of a service desk.",
      legacyName: "jsm.listQueues",
      input: { serviceDeskId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getQueue",
      description: "Get a single queue by id.",
      legacyName: "jsm.getQueue",
      input: { serviceDeskId, queueId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`,
          );
        return resp.data;
      },
    }),
    defineOp({
      op: "getQueueIssues",
      description: "Get the issues currently visible in a queue.",
      legacyName: "jsm.getQueueIssues",
      input: { serviceDeskId, queueId, start: pageStart.optional(), limit: pageLimit.optional() },
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
    defineOp({
      op: "getRequestSla",
      description:
        "Get the SLA state (cycles, breach status, remaining time) for a single customer request, by issue id/key. SLA *configuration* has no public API; only per-request state is readable.",
      legacyName: "jsm.getRequestSla",
      input: {
        issueIdOrKey: z.string().min(1).describe("The request/issue id or key, e.g. ISD-42."),
        start: pageStart.optional(),
        limit: pageLimit.optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${SD}/request/${encodeURIComponent(input.issueIdOrKey)}/sla?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listJsmOrganizations",
      description: "List organizations in a service desk, or globally when serviceDeskId is omitted.",
      legacyName: "jsm.listJsmOrganizations",
      input: { serviceDeskId: serviceDeskId.optional(), start: pageStart.optional(), limit: pageLimit.optional() },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({ start: String(input.start ?? 0), limit: String(input.limit ?? 50) });
        const path = input.serviceDeskId
          ? `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/organization?${p.toString()}`
          : `${SD}/organization?${p.toString()}`;
        const resp = await ctx.client.apiTokenJira().get<unknown>(path);
        return resp.data;
      },
    }),
    defineOp({
      op: "searchKnowledgeBaseArticles",
      description: "Search the knowledge-base articles surfaced by a service desk. (Article LINKING is UI-only.)",
      legacyName: "jsm.searchKnowledgeBaseArticles",
      input: {
        serviceDeskId,
        query: z.string().min(1).describe("Search query"),
        highlight: z.boolean().optional(),
        start: pageStart.optional(),
        limit: pageLimit.optional(),
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
          .get<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/knowledgebase/article?${p.toString()}`,
          );
        return resp.data;
      },
    }),
  ],
});

const jsmManage = defineOpTool({
  name: "jsm.manage",
  description:
    "JSM additions: create a request type on a service desk (createRequestType) or add customers to a JSM organization (addCustomersToOrganization). Both revertible.",
  group: "write_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createRequestType",
      description: "Create a request type. Revertible (the created type is deletable).",
      destructive: true,
      legacyName: "jsm.createRequestType",
      input: {
        serviceDeskId,
        issueTypeId: z.string().min(1).describe("Backing issue type id"),
        name: z.string().min(1).describe("Request type name"),
        description: z.string().optional(),
        helpText: z.string().optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          issueTypeId: input.issueTypeId,
          name: input.name,
          description: input.description,
          helpText: input.helpText,
        };
        const dry = meta.dryRun({
          target: { kind: "request_type", name: input.name, parent: input.serviceDeskId },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Revert a created request type by deleting it. The created id is
      // persisted onto the journal target via deriveTargetId.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const t = entry.target as { id?: string; parent?: string };
        if (!t.id || !t.parent) throw new Error("Cannot revert: request type id/serviceDeskId missing from target.");
        await ctx.client
          .apiTokenJira()
          .delete<unknown>(`${SD}/servicedesk/${encodeURIComponent(t.parent)}/requesttype/${encodeURIComponent(t.id)}`);
        return { deleted: t.id };
      },
    }),
    defineOp({
      op: "addCustomersToOrganization",
      description:
        "Add customers (by accountId or email) to a JSM organization. Conditionally revertible: the revert removes only the customers the call actually added.",
      destructive: true,
      legacyName: "jsm.addCustomersToOrganization",
      claimsRevertible: true,
      input: {
        organizationId,
        usernames: customerUsernames.optional(),
        accountIds: customerAccountIds.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.apiTokenJira();
        const body: Record<string, unknown> = {};
        if (input.usernames?.length) body.usernames = input.usernames;
        if (input.accountIds?.length) body.accountIds = input.accountIds;
        // Prior membership: the customers a revert must NOT touch (the add no-ops for them).
        const priorMembers = await tryFetchOrganizationMembers(c, input.organizationId);
        const dry = meta.dryRun({
          target: { kind: "jsm_organization", id: input.organizationId },
          before: { memberAccountIds: priorMembers },
          after: body,
        });
        if (dry) return dry;
        const revertible = priorMembers !== null;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "jsm_organization", id: input.organizationId },
          before: { memberAccountIds: priorMembers },
          // organizationId is the path param, `body` the customer list — the reverter needs both.
          request: { organizationId: input.organizationId, ...body },
          revertible,
          revertHint: revertible
            ? "Remove ONLY the customers this call actually added (`after.added`); customers that were already members stay."
            : MEMBERSHIP_SNAPSHOT_UNAVAILABLE,
          run: async () => {
            await c.post<unknown>(`${SD}/organization/${encodeURIComponent(input.organizationId)}/user`, body);
            if (priorMembers === null) return { added: null, ...body };
            const nowMembers = await tryFetchOrganizationMembers(c, input.organizationId);
            // The add landed; a failed re-read must not fail the op — record the gap instead.
            if (nowMembers === null) return { added: null, ...body };
            return { added: membersDiff(nowMembers, priorMembers), ...body };
          },
        });
        const after = entry.after as { added: string[] | null };
        return { ok: true, journal_id: entry.opId, added: after.added };
      },
      // Reverting an add = remove only the customers the add actually created.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const { path, accountIds } = organizationRevertCall(entry, "added");
        if (accountIds.length === 0) return { removed: [], noop: "every submitted customer was already a member" };
        await ctx.client.apiTokenJira().delete<unknown>(path, { data: { accountIds } });
        return { removed: accountIds };
      },
    }),
  ],
});

const jsmDelete = defineOpTool({
  name: "jsm.delete",
  description:
    "Destructive JSM removals: delete a request type from a service desk (deleteRequestType — irreversible) or remove customers from a JSM organization (removeCustomersFromOrganization — conditionally revertible).",
  group: "write_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "deleteRequestType",
      description: "Delete a request type. Irreversible.",
      destructive: true,
      legacyName: "jsm.deleteRequestType",
      input: { serviceDeskId, requestTypeId },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.apiTokenJira();
        const before = await c.get<unknown>(
          `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
        );
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
            before: before.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
          before: before.data,
          request: {
            serviceDeskId: input.serviceDeskId,
            requestTypeId: input.requestTypeId,
          } as Record<string, unknown>,
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
    defineOp({
      op: "removeCustomersFromOrganization",
      description:
        "Remove customers (by accountId or email) from a JSM organization. Conditionally revertible: the revert re-adds only the customers the call actually removed.",
      destructive: true,
      legacyName: "jsm.removeCustomersFromOrganization",
      claimsRevertible: true,
      input: {
        organizationId,
        usernames: customerUsernames.optional(),
        accountIds: customerAccountIds.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.apiTokenJira();
        const body: Record<string, unknown> = {};
        if (input.usernames?.length) body.usernames = input.usernames;
        if (input.accountIds?.length) body.accountIds = input.accountIds;
        // Prior membership: a revert re-adds only the customers that were really there and really left.
        const priorMembers = await tryFetchOrganizationMembers(c, input.organizationId);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "jsm_organization", id: input.organizationId },
            before: { memberAccountIds: priorMembers, removing: body },
          });
        }
        const revertible = priorMembers !== null;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "jsm_organization", id: input.organizationId },
          before: { memberAccountIds: priorMembers },
          // organizationId is the path param, `body` the customer list — the reverter needs both.
          request: { organizationId: input.organizationId, ...body },
          revertible,
          revertHint: revertible
            ? "Re-add ONLY the customers this call actually removed (`after.removed`); customers that were not members stay out."
            : MEMBERSHIP_SNAPSHOT_UNAVAILABLE,
          run: async () => {
            await c.delete<unknown>(`${SD}/organization/${encodeURIComponent(input.organizationId)}/user`, {
              data: body,
            });
            if (priorMembers === null) return { removed: null, ...body };
            const nowMembers = await tryFetchOrganizationMembers(c, input.organizationId);
            // The removal landed; a failed re-read must not fail the op — record the gap instead.
            if (nowMembers === null) return { removed: null, ...body };
            return { removed: membersDiff(priorMembers, nowMembers), ...body };
          },
        });
        const after = entry.after as { removed: string[] | null };
        return { ok: true, journal_id: entry.opId, removed: after.removed };
      },
      // Reverting a remove = re-add only the customers the removal actually evicted.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const { path, accountIds } = organizationRevertCall(entry, "removed");
        if (accountIds.length === 0) return { added: [], noop: "no submitted customer was a member" };
        await ctx.client.apiTokenJira().post<unknown>(path, { accountIds });
        return { added: accountIds };
      },
    }),
  ],
});

export const jsmTools = (): AnyToolDef[] => [jsmReadServiceDesk, jsmReadSupport, jsmManage, jsmDelete];

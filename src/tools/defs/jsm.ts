import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * JSM admin tools — API token side-channel.
 * Base URL is the user's site (e.g. https://acme.atlassian.net) via apiTokenJira().
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

  // --- Request types ---
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
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<{ id: string }>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype`, body);
          return resp.data;
        },
      });
      const created = entry.after as { id?: string };
      if (created?.id) entry.target = { ...entry.target, id: created.id };
      return { ok: true, journal_id: entry.opId, requestType: created };
    },
  }),
  defineTool({
    name: "jsm.updateRequestType",
    description: "Update a request type's name/description/helpText.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      requestTypeId: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      helpText: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
      );
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.helpText !== undefined) body.helpText = input.helpText;
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.updateRequestType",
        target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.updateRequestType",
        cloudId: ctx.cloudId,
        target: { kind: "request_type", id: input.requestTypeId, parent: input.serviceDeskId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}`,
            body,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
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
    name: "jsm.setRequestTypeFields",
    description: "Replace the field set on a request type.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      requestTypeId: z.string().min(1),
      fields: z.array(z.record(z.string(), z.unknown())).min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/field`,
      );
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.setRequestTypeFields",
        target: { kind: "request_type_fields", id: input.requestTypeId, parent: input.serviceDeskId },
        before: before.data,
        after: { fields: input.fields },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.setRequestTypeFields",
        cloudId: ctx.cloudId,
        target: { kind: "request_type_fields", id: input.requestTypeId, parent: input.serviceDeskId },
        before: before.data,
        request: { fields: input.fields } as Record<string, unknown>,
        revertible: true,
        revertHint: "Re-issue setRequestTypeFields with the captured `before.fields`.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/field`,
            { fields: input.fields },
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "jsm.getRequestTypeGroups",
    description: "List request-type groups inside a service desk.",
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
    name: "jsm.assignRequestTypeToGroup",
    description: "Assign an existing request type to a group inside the same service desk.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      requestTypeId: z.string().min(1),
      groupId: z.string().min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { groupId: input.groupId };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.assignRequestTypeToGroup",
        target: { kind: "request_type_group_assignment", id: input.requestTypeId, parent: input.serviceDeskId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.assignRequestTypeToGroup",
        cloudId: ctx.cloudId,
        target: { kind: "request_type_group_assignment", id: input.requestTypeId, parent: input.serviceDeskId },
        before: null,
        request: body as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<unknown>(
              `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttypegroup/${encodeURIComponent(input.groupId)}/requesttype`,
              { requestTypeId: input.requestTypeId },
            );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Queues ---
  defineTool({
    name: "jsm.listQueues",
    description: "List queues for a service desk.",
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
    name: "jsm.createQueue",
    description: "Create a queue. Revertible (delete).",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      name: z.string().min(1),
      jql: z.string().min(1),
      fields: z.array(z.string()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { name: input.name, jql: input.jql, fields: input.fields };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.createQueue",
        target: { kind: "queue", name: input.name, parent: input.serviceDeskId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.createQueue",
        cloudId: ctx.cloudId,
        target: { kind: "queue", name: input.name, parent: input.serviceDeskId },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE /rest/servicedeskapi/servicedesk/{sd}/queue/{id} on the created queue.",
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<{ id: string }>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue`, body);
          return resp.data;
        },
      });
      const created = entry.after as { id?: string };
      if (created?.id) entry.target = { ...entry.target, id: created.id };
      return { ok: true, journal_id: entry.opId, queue: created };
    },
  }),
  defineTool({
    name: "jsm.updateQueue",
    description: "Update a queue's name/jql/fields.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      queueId: z.string().min(1),
      name: z.string().optional(),
      jql: z.string().optional(),
      fields: z.array(z.string()).optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`,
      );
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.jql !== undefined) body.jql = input.jql;
      if (input.fields !== undefined) body.fields = input.fields;
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.updateQueue",
        target: { kind: "queue", id: input.queueId, parent: input.serviceDeskId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.updateQueue",
        cloudId: ctx.cloudId,
        target: { kind: "queue", id: input.queueId, parent: input.serviceDeskId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`,
            body,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "jsm.deleteQueue",
    description: "Delete a queue. Irreversible.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      queueId: z.string().min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`,
      );
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "jsm.deleteQueue",
          target: { kind: "queue", id: input.queueId, parent: input.serviceDeskId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.deleteQueue",
        cloudId: ctx.cloudId,
        target: { kind: "queue", id: input.queueId, parent: input.serviceDeskId },
        before: before.data,
        request: { ...input } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/queue/${encodeURIComponent(input.queueId)}`,
          );
          return { deleted: input.queueId };
        },
      });
      return { ok: true, journal_id: entry.opId };
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

  // --- SLAs ---
  defineTool({
    name: "jsm.listSlas",
    description: "List SLA configurations for a project.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { projectKey: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/projects/${encodeURIComponent(input.projectKey)}/sla`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getSla",
    description: "Get an SLA by id.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { projectKey: z.string().min(1), slaId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/projects/${encodeURIComponent(input.projectKey)}/sla/${encodeURIComponent(input.slaId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.createSla",
    description: "Create an SLA configuration. Destructive — requires `commit:true`.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      projectKey: z.string().min(1),
      sla: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.createSla",
        target: { kind: "sla", parent: input.projectKey, name: (input.sla as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: input.sla,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.createSla",
        cloudId: ctx.cloudId,
        target: { kind: "sla", parent: input.projectKey, name: (input.sla as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { sla: input.sla } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<unknown>(`${SD}/projects/${encodeURIComponent(input.projectKey)}/sla`, input.sla);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, sla: entry.after };
    },
  }),
  defineTool({
    name: "jsm.updateSla",
    description: "Update an SLA.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      projectKey: z.string().min(1),
      slaId: z.string().min(1),
      sla: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/projects/${encodeURIComponent(input.projectKey)}/sla/${encodeURIComponent(input.slaId)}`,
      );
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.updateSla",
        target: { kind: "sla", id: input.slaId, parent: input.projectKey },
        before: before.data,
        after: input.sla,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.updateSla",
        cloudId: ctx.cloudId,
        target: { kind: "sla", id: input.slaId, parent: input.projectKey },
        before: before.data,
        request: { sla: input.sla } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/projects/${encodeURIComponent(input.projectKey)}/sla/${encodeURIComponent(input.slaId)}`,
            input.sla,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "jsm.getSlaMetrics",
    description: "Get SLA breach metrics for a project (filtered by time range and metric ids).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: {
      projectKey: z.string().min(1),
      since: z.string().datetime().optional(),
      until: z.string().datetime().optional(),
      metricIds: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams();
      if (input.since) p.set("since", input.since);
      if (input.until) p.set("until", input.until);
      if (input.metricIds?.length) for (const id of input.metricIds) p.append("metricId", id);
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(
          `${SD}/projects/${encodeURIComponent(input.projectKey)}/sla/metrics${p.toString() ? `?${p.toString()}` : ""}`,
        );
      return resp.data;
    },
  }),

  // --- JSM Organizations ---
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
        request: body,
        revertible: false,
        run: async () => {
          await ctx.client
            .apiTokenJira()
            .post<unknown>(`${SD}/organization/${encodeURIComponent(input.organizationId)}/user`, body);
          return { added: true };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Portals ---
  defineTool({
    name: "jsm.listPortals",
    description: "List customer portals exposed by this site.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    handler: async (_input, ctx) => {
      const resp = await ctx.client.apiTokenJira().get<unknown>(`${SD}/servicedesk`);
      return resp.data; // /servicedesk doubles as the portal listing.
    },
  }),
  defineTool({
    name: "jsm.getPortalCustomization",
    description: "Retrieve a portal's customization (announcements, branding).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/announcement`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.updatePortalCustomization",
    description: "Update a portal's announcement / branding settings.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      announcement: z
        .object({ subject: z.string().optional(), description: z.string().optional() })
        .optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/announcement`);
      const after = { ...(before.data as object), announcement: input.announcement };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.updatePortalCustomization",
        target: { kind: "portal", id: input.serviceDeskId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.updatePortalCustomization",
        cloudId: ctx.cloudId,
        target: { kind: "portal", id: input.serviceDeskId },
        before: before.data,
        request: { announcement: input.announcement } as Record<string, unknown>,
        revertible: true,
        revertHint: "Re-POST the captured `before.announcement`.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/announcement`,
            input.announcement ?? {},
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Forms ---
  defineTool({
    name: "jsm.listForms",
    description: "List request forms attached to a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/form`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.getForm",
    description: "Get a single form by id.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), formId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/form/${encodeURIComponent(input.formId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.createForm",
    description: "Create a request form.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      form: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.createForm",
        target: { kind: "form", parent: input.serviceDeskId, name: (input.form as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: input.form,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.createForm",
        cloudId: ctx.cloudId,
        target: { kind: "form", parent: input.serviceDeskId, name: (input.form as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { form: input.form } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/form`, input.form);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, form: entry.after };
    },
  }),
  defineTool({
    name: "jsm.updateForm",
    description: "Replace a form's body.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      formId: z.string().min(1),
      form: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.apiTokenJira();
      const before = await c.get<unknown>(
        `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/form/${encodeURIComponent(input.formId)}`,
      );
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.updateForm",
        target: { kind: "form", id: input.formId, parent: input.serviceDeskId },
        before: before.data,
        after: input.form,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.updateForm",
        cloudId: ctx.cloudId,
        target: { kind: "form", id: input.formId, parent: input.serviceDeskId },
        before: before.data,
        request: { form: input.form } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(
            `${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/form/${encodeURIComponent(input.formId)}`,
            input.form,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // --- Knowledge base ---
  defineTool({
    name: "jsm.getServiceDeskKnowledgeBase",
    description: "Returns the linked Confluence KB for a service desk.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .apiTokenJira()
        .get<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/knowledgebase`);
      return resp.data;
    },
  }),
  defineTool({
    name: "jsm.linkKbToServiceDesk",
    description: "Link a Confluence space (by spaceKey) as the KB for a service desk.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      serviceDeskId: z.string().min(1),
      spaceKey: z.string().min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "jsm.linkKbToServiceDesk",
        target: { kind: "kb_link", id: input.serviceDeskId },
        before: null,
        after: { spaceKey: input.spaceKey },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "jsm.linkKbToServiceDesk",
        cloudId: ctx.cloudId,
        target: { kind: "kb_link", id: input.serviceDeskId },
        before: null,
        request: { spaceKey: input.spaceKey } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client
            .apiTokenJira()
            .post<unknown>(`${SD}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/knowledgebase`, {
              spaceKey: input.spaceKey,
            });
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
];

// Reverter for createQueue
reverters.register("jsm.createQueue", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const t = entry.target as { id?: string; parent?: string };
  if (!t.id || !t.parent) throw new Error("Cannot revert: queue id/parent missing.");
  await ctx.client
    .apiTokenJira()
    .delete<unknown>(`${SD}/servicedesk/${encodeURIComponent(t.parent)}/queue/${encodeURIComponent(t.id)}`);
  return { deleted: t.id };
});

reverters.register("jsm.createRequestType", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const t = entry.target as { id?: string; parent?: string };
  if (!t.id || !t.parent) throw new Error("Cannot revert: request type id/parent missing.");
  await ctx.client
    .apiTokenJira()
    .delete<unknown>(
      `${SD}/servicedesk/${encodeURIComponent(t.parent)}/requesttype/${encodeURIComponent(t.id)}`,
    );
  return { deleted: t.id };
});

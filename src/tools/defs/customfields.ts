import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

export const customFieldTools = (): AnyToolDef[] => [
  defineTool({
    name: "customfields.listCustomFields",
    description: "List Jira custom fields (paginated). Filter by query string or field type.",
    group: "read_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(200).default(50).optional(),
      query: z.string().optional(),
      type: z.array(z.string()).optional(),
      id: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams();
      p.set("startAt", String(input.startAt ?? 0));
      p.set("maxResults", String(input.maxResults ?? 50));
      if (input.query) p.set("query", input.query);
      if (input.type?.length) for (const t of input.type) p.append("type", t);
      if (input.id?.length) for (const id of input.id) p.append("id", id);
      const resp = await ctx.client.jira().get<unknown>(`/rest/api/3/field/search?${p.toString()}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "customfields.getCustomField",
    description: "Get a custom field's metadata (and contexts when expand='contexts' is included).",
    group: "read_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    input: { fieldId: z.string().min(1), include_contexts: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const f = await c.get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}`);
      if (!input.include_contexts) return f.data;
      const ctxs = await c.get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context`);
      return { field: f.data, contexts: ctxs.data };
    },
  }),

  defineTool({
    name: "customfields.createCustomField",
    description: "Create a new custom field. Revertible (the created field is deletable).",
    group: "write_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1).max(255),
      description: z.string().optional(),
      type: z.string().min(1).describe('Field type key, e.g. "com.atlassian.jira.plugin.system.customfieldtypes:textfield".'),
      searcherKey: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        name: input.name,
        description: input.description,
        type: input.type,
        searcherKey: input.searcherKey,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "customfields.createCustomField",
        target: { kind: "custom_field", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;

      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "customfields.createCustomField",
        cloudId: ctx.cloudId,
        target: { kind: "custom_field", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE /rest/api/3/field/{id} on the created field.",
        deriveTargetId: (after) => (after as { id?: string })?.id,
        run: async () => {
          const resp = await ctx.client.jira().post<{ id: string; name: string }>("/rest/api/3/field", body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, field: entry.after };
    },
  }),

  defineTool({
    name: "customfields.updateCustomField",
    description: "Update a custom field's name, description, or searcher.",
    group: "write_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      fieldId: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      searcherKey: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const before = await ctx.client.jira().get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}`);
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.searcherKey !== undefined) body.searcherKey = input.searcherKey;
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "customfields.updateCustomField",
        target: { kind: "custom_field", id: input.fieldId },
        before: before.data,
        after,
      });
      if (dry) return dry;

      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "customfields.updateCustomField",
        cloudId: ctx.cloudId,
        target: { kind: "custom_field", id: input.fieldId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back via /rest/api/3/field/{id}.",
        run: async () => {
          const resp = await ctx.client
            .jira()
            .put<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "customfields.deleteCustomField",
    description: "Delete a custom field. **Irreversible.** Re-invoke with `commit:true`.",
    group: "write_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { fieldId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const before = await ctx.client.jira().get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "customfields.deleteCustomField",
          target: { kind: "custom_field", id: input.fieldId },
          before: before.data,
          message: "This would DELETE the custom field and may detach values from issues. Irreversible.",
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "customfields.deleteCustomField",
        cloudId: ctx.cloudId,
        target: { kind: "custom_field", id: input.fieldId },
        before: before.data,
        request: { fieldId: input.fieldId } as Record<string, unknown>,
        revertible: false,
        revertHint: "Custom field deletion is irreversible.",
        run: async () => {
          await ctx.client.jira().delete<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}`);
          return { deleted: true };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "customfields.listCustomFieldContexts",
    description: "List the contexts (project scopes) for a custom field.",
    group: "read_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      fieldId: z.string().min(1),
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        startAt: String(input.startAt ?? 0),
        maxResults: String(input.maxResults ?? 50),
      });
      const resp = await ctx.client
        .jira()
        .get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context?${p.toString()}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "customfields.assignCustomFieldToProjects",
    description: "Assign a custom field context to projects. Destructive — requires `commit:true`.",
    group: "write_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      fieldId: z.string().min(1),
      contextId: z.string().min(1),
      projectIds: z.array(z.string()).min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = { projectIds: input.projectIds };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "customfields.assignCustomFieldToProjects",
        target: { kind: "custom_field_context", id: input.contextId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "customfields.assignCustomFieldToProjects",
        cloudId: ctx.cloudId,
        target: { kind: "custom_field_context", id: input.contextId, parent: input.fieldId },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "POST removeProjects with the same project ids.",
        run: async () => {
          const resp = await ctx.client
            .jira()
            .put<unknown>(
              `/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context/${encodeURIComponent(
                input.contextId,
              )}/project`,
              body,
            );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "customfields.setCustomFieldOptions",
    description:
      "Create and/or update options on a custom field context (for select/multi-select fields). " +
      "Options WITHOUT an `id` are created; options WITH an `id` update that existing option.",
    group: "write_customfields",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      fieldId: z.string().min(1),
      contextId: z.string().min(1),
      options: z
        .array(
          z.object({
            value: z.string().min(1),
            disabled: z.boolean().optional(),
            // Present => update this existing option (PUT). Absent => create a new one (POST).
            id: z.string().optional(),
            // Optional cascading-select parent option id (create only).
            optionId: z.string().optional(),
          }),
        )
        .min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const optionPath = `/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context/${encodeURIComponent(
        input.contextId,
      )}/option`;
      const before = await c.get<unknown>(optionPath);
      // The Jira API splits create vs update: POST creates options (no id), PUT
      // updates existing ones by required `id`. A single "replace" call cannot
      // do both, so we route each option to the correct verb.
      const toCreate = input.options.filter((o) => !o.id);
      const toUpdate = input.options.filter((o) => o.id);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "customfields.setCustomFieldOptions",
        target: { kind: "custom_field_context_options", id: input.contextId, parent: input.fieldId },
        before: before.data,
        after: { create: toCreate, update: toUpdate },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "customfields.setCustomFieldOptions",
        cloudId: ctx.cloudId,
        target: { kind: "custom_field_context_options", id: input.contextId, parent: input.fieldId },
        before: before.data,
        request: { create: toCreate.length, update: toUpdate.length } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const results: Record<string, unknown> = {};
          if (toCreate.length > 0) {
            const resp = await c.post<unknown>(optionPath, {
              options: toCreate.map((o) => ({
                value: o.value,
                disabled: o.disabled,
                ...(o.optionId ? { optionId: o.optionId } : {}),
              })),
            });
            results.created = resp.data;
          }
          if (toUpdate.length > 0) {
            const resp = await c.put<unknown>(optionPath, {
              options: toUpdate.map((o) => ({ id: o.id, value: o.value, disabled: o.disabled })),
            });
            results.updated = resp.data;
          }
          return results;
        },
      });
      return { ok: true, journal_id: entry.opId, result: entry.after };
    },
  }),
];

// Reverter: delete the newly-created custom field.
reverters.register("customfields.createCustomField", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: created field id missing from target.");
  await ctx.client.jira().delete<unknown>(`/rest/api/3/field/${encodeURIComponent(id)}`);
  return { deleted: id };
});

// Reverting an update = PUT the captured `before` back. PUT /field/{id} is a
// PARTIAL update, so `description` is always sent (defaulting to ""): omitting it
// would leave a newly-added description in place instead of clearing it.
reverters.register("customfields.updateCustomField", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: custom field id missing from target.");
  const before = entry.before as { name?: string; description?: string; searcherKey?: string } | null;
  // PUT /field/{id} requires `name`, so a snapshot without one is unusable.
  if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` field name.");
  const body: Record<string, unknown> = { name: before.name, description: before.description ?? "" };
  if (before.searcherKey !== undefined) body.searcherKey = before.searcherKey;
  const resp = await ctx.client.jira().put<unknown>(`/rest/api/3/field/${encodeURIComponent(id)}`, body);
  return { reverted: id, response: resp.data };
});

// Reverting an assign = remove exactly the project ids that were assigned. The
// field id rides on target.parent, the context id on target.id, and the project
// ids on the journaled request.
reverters.register("customfields.assignCustomFieldToProjects", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const t = entry.target as { id?: string; parent?: string };
  if (!t.id || !t.parent) throw new Error("Cannot revert: context id or field id missing from target.");
  const projectIds = (entry.request as { projectIds?: string[] } | null)?.projectIds;
  if (!projectIds?.length) throw new Error("Cannot revert: no project ids recorded on the journal entry.");
  const resp = await ctx.client
    .jira()
    .post<unknown>(
      `/rest/api/3/field/${encodeURIComponent(t.parent)}/context/${encodeURIComponent(t.id)}/project/remove`,
      { projectIds },
    );
  return { removed: projectIds, response: resp.data };
});

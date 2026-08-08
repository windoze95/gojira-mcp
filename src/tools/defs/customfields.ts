import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDeleteDryRun } from "../../consent/dryRun.js";
import { NotFoundError } from "../../middleware/errorHandler.js";
import type { ToolContext } from "../types.js";

/**
 * Read a single custom field.
 *
 * There is NO single-field GET in Jira Cloud: `GET /rest/api/3/field/{fieldId}`
 * returns **405 Method Not Allowed** (that path is PUT/DELETE only) — verified
 * live. The paginated search endpoint filtered by id is the only way to read one
 * field, and it is what the before-snapshots of update/delete depend on, so this
 * helper is shared by every read path in this file.
 */
async function readField(ctx: ToolContext, fieldId: string): Promise<Record<string, unknown>> {
  const resp = await ctx.client
    .jira()
    .get<{ values?: Array<Record<string, unknown>> }>(
      `/rest/api/3/field/search?id=${encodeURIComponent(fieldId)}`,
    );
  const field = resp.data.values?.[0];
  if (!field) throw new NotFoundError(`No custom field found with id ${fieldId}`);
  return field;
}

// Hoisted shared field schemas.
const cfFieldId = z.string().min(1).describe("Custom field id (e.g. customfield_10011)");
const cfStartAt = z.number().int().nonnegative().default(0).describe("Page offset");
// listCustomFields accepts up to 200; listCustomFieldContexts caps at 100 —
// unified here, clamped in the contexts handler.
const cfMaxResults = z
  .number()
  .int()
  .positive()
  .max(200)
  .default(50)
  .describe("Page size (listCustomFieldContexts clamps to 100)");
const cfName = z.string().min(1).max(255).describe("Field name");
const cfDescription = z.string().describe("Field description");
const cfSearcherKey = z.string().describe("Searcher key for the field type");
const cfContextId = z.string().min(1).describe("Field context id");

const customfieldsRead = defineOpTool({
  name: "customfields.read",
  description:
    "Read custom fields: paged list/search (listCustomFields), get one field's metadata optionally with contexts (getCustomField), list a field's contexts (listCustomFieldContexts).",
  group: "read_customfields",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listCustomFields",
      description: "List Jira custom fields (paginated); filter by query string, field type, or ids.",
      legacyName: "customfields.listCustomFields",
      input: {
        startAt: cfStartAt.optional(),
        maxResults: cfMaxResults.optional(),
        query: z.string().optional().describe("Substring match against field names"),
        type: z.array(z.string()).optional().describe("Field type filters"),
        id: z.array(z.string()).optional().describe("Field id filters"),
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
    defineOp({
      op: "getCustomField",
      description: "Get a custom field's metadata (and its contexts when includeContexts is true).",
      legacyName: "customfields.getCustomField",
      input: {
        fieldId: cfFieldId,
        includeContexts: z.boolean().optional().describe("Also fetch the field's contexts"),
      },
      handler: async (input, ctx) => {
        const field = await readField(ctx, input.fieldId);
        if (!input.includeContexts) return field;
        const ctxs = await ctx.client
          .jira()
          .get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context`);
        return { field, contexts: ctxs.data };
      },
    }),
    defineOp({
      op: "listCustomFieldContexts",
      description: "List the contexts (project scopes) for a custom field. Page size caps at 100.",
      legacyName: "customfields.listCustomFieldContexts",
      input: {
        fieldId: cfFieldId,
        startAt: cfStartAt.optional(),
        maxResults: cfMaxResults.optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          // The contexts endpoint rejects >100 — clamp the unified 1..200 schema.
          maxResults: String(Math.min(input.maxResults ?? 50, 100)),
        });
        const resp = await ctx.client
          .jira()
          .get<unknown>(`/rest/api/3/field/${encodeURIComponent(input.fieldId)}/context?${p.toString()}`);
        return resp.data;
      },
    }),
  ],
});

const customfieldsManage = defineOpTool({
  name: "customfields.manage",
  description:
    "Manage custom fields: create one (createCustomField), update name/description/searcher (updateCustomField), assign a field context to projects (assignCustomFieldToProjects), or create/update select-list options (setCustomFieldOptions).",
  group: "write_customfields",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createCustomField",
      description: "Create a new custom field. Revertible (the created field is deletable).",
      destructive: true,
      legacyName: "customfields.createCustomField",
      input: {
        name: cfName,
        description: cfDescription.optional(),
        type: z
          .string()
          .min(1)
          .describe('Field type key, e.g. "com.atlassian.jira.plugin.system.customfieldtypes:textfield".'),
        searcherKey: cfSearcherKey.optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          name: input.name,
          description: input.description,
          type: input.type,
          searcherKey: input.searcherKey,
        };
        const dry = meta.dryRun({
          target: { kind: "custom_field", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;

        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverter: delete the newly-created custom field.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: created field id missing from target.");
        await ctx.client.jira().delete<unknown>(`/rest/api/3/field/${encodeURIComponent(id)}`);
        return { deleted: id };
      },
    }),
    defineOp({
      op: "updateCustomField",
      description: "Update a custom field's name, description, or searcher. Revertible.",
      destructive: true,
      legacyName: "customfields.updateCustomField",
      input: {
        fieldId: cfFieldId,
        name: cfName.optional(),
        description: cfDescription.optional(),
        searcherKey: cfSearcherKey.optional(),
      },
      handler: async (input, ctx, meta) => {
        // No single-field GET exists (405) — see readField().
        const before = { data: await readField(ctx, input.fieldId) };
        const body: Record<string, unknown> = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.description !== undefined) body.description = input.description;
        if (input.searcherKey !== undefined) body.searcherKey = input.searcherKey;
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "custom_field", id: input.fieldId },
          before: before.data,
          after,
        });
        if (dry) return dry;

        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting an update = PUT the captured `before` back. PUT /field/{id}
      // is a PARTIAL update, so `description` is always sent (defaulting to ""):
      // omitting it would leave a newly-added description in place instead of
      // clearing it.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: custom field id missing from target.");
        const before = entry.before as { name?: string; description?: string; searcherKey?: string } | null;
        // PUT /field/{id} requires `name`, so a snapshot without one is unusable.
        if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` field name.");
        const body: Record<string, unknown> = { name: before.name, description: before.description ?? "" };
        if (before.searcherKey !== undefined) body.searcherKey = before.searcherKey;
        const resp = await ctx.client.jira().put<unknown>(`/rest/api/3/field/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
    defineOp({
      op: "assignCustomFieldToProjects",
      description: "Assign a custom field context to projects. Revertible (removes the same project ids).",
      destructive: true,
      legacyName: "customfields.assignCustomFieldToProjects",
      input: {
        fieldId: cfFieldId,
        contextId: cfContextId,
        projectIds: z.array(z.string()).min(1).describe("Project ids to assign the context to"),
      },
      handler: async (input, ctx, meta) => {
        const body = { projectIds: input.projectIds };
        // Target carries parent=fieldId in BOTH the dry run and the journal —
        // the pre-collapse dry run omitted it (target drift, fixed here).
        const target = { kind: "custom_field_context", id: input.contextId, parent: input.fieldId };
        const dry = meta.dryRun({ target, before: null, after: body });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target,
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
      // Reverting an assign = remove exactly the project ids that were assigned.
      // The field id rides on target.parent, the context id on target.id, and
      // the project ids on the journaled request.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
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
      },
    }),
    defineOp({
      op: "setCustomFieldOptions",
      description:
        "Create and/or update options on a custom field context (select/multi-select fields). Options WITHOUT an id are created; options WITH an id update that existing option.",
      destructive: true,
      legacyName: "customfields.setCustomFieldOptions",
      input: {
        fieldId: cfFieldId,
        contextId: cfContextId,
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
          .min(1)
          .describe("Options to create (no id) or update (with id)"),
      },
      handler: async (input, ctx, meta) => {
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
        const dry = meta.dryRun({
          target: { kind: "custom_field_context_options", id: input.contextId, parent: input.fieldId },
          before: before.data,
          after: { create: toCreate, update: toUpdate },
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
  ],
});

const customfieldsDelete = defineTool({
  name: "customfields.delete",
  description: "Delete a custom field. **Irreversible.** Re-invoke with `commit:true`.",
  group: "write_customfields",
  authMethod: "oauth",
  needsCloudId: true,
  destructive: true,
  legacyName: "customfields.deleteCustomField",
  input: { fieldId: z.string().min(1), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    // No single-field GET exists (405) — see readField().
    const before = { data: await readField(ctx, input.fieldId) };
    if (input.commit !== true) {
      return buildDeleteDryRun({
        tool: "customfields.delete",
        target: { kind: "custom_field", id: input.fieldId },
        before: before.data,
        message: "This would DELETE the custom field and may detach values from issues. Irreversible.",
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
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
});

export const customFieldTools = (): AnyToolDef[] => [customfieldsRead, customfieldsManage, customfieldsDelete];

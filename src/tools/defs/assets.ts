import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { getAssetsWorkspaceId } from "../../atlassian/assetsWorkspace.js";
import { ToolError } from "../../middleware/errorHandler.js";
import { reverters } from "../../operations/revert.js";

/**
 * Assets (Insight) — OAuth bearer + CMDB scopes.
 *
 * The Assets API is rooted at api.atlassian.com/jsm/assets/workspace/<wsId>/v1.
 * We discover wsId per cloudId via the OAuth-authed JSM endpoint and cache
 * for 24h (see atlassian/assetsWorkspace.ts).
 *
 * Auth note: these tools authenticate with the caller's OAuth bearer (both the
 * workspace-discovery call and every data-plane call go through the OAuth-authed
 * `ctx.client.assets()` factory), so they require Assets/CMDB OAuth scopes on
 * the app — e.g. read:cmdb-object:jira, write:cmdb-object:jira,
 * read:cmdb-schema:jira, write:cmdb-schema:jira. (Previously these tools
 * declared the api_token side-channel, which the code never actually used.)
 * NOTE: endpoint corrections below follow Atlassian's Assets API reference; they
 * were NOT live-verified because the dev app lacks CMDB scopes.
 */

async function workspace(ctx: import("../types.js").ToolContext): Promise<string> {
  if (!ctx.cloudId) throw new ToolError("VALIDATION_ERROR", "cloudId required for Assets calls");
  // Discovery requires OAuth + JSM scopes.
  if (!ctx.storedToken)
    throw new ToolError(
      "AUTH_REQUIRED",
      "Assets workspace discovery requires an OAuth grant with JSM scopes; the bound API token alone is insufficient for discovery.",
    );
  return getAssetsWorkspaceId(ctx.redis, ctx.cloudId, ctx.storedToken.access_token);
}

export const assetsTools = (): AnyToolDef[] => [
  defineTool({
    name: "assets.listObjectSchemas",
    description: "List Assets object schemas in this workspace.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    handler: async (_input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>("/objectschema/list");
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.getObjectSchema",
    description: "Get a single object schema by id.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemaId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.createObjectSchema",
    description: "Create a new object schema. Destructive — requires `commit:true`.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      name: z.string().min(1),
      objectSchemaKey: z.string().min(1),
      description: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const body = {
        name: input.name,
        objectSchemaKey: input.objectSchemaKey,
        description: input.description,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.createObjectSchema",
        target: { kind: "asset_schema", name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.createObjectSchema",
        cloudId: ctx.cloudId,
        target: { kind: "asset_schema", name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client.assets(ws).post<unknown>("/objectschema/create", body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, schema: entry.after };
    },
  }),
  defineTool({
    name: "assets.updateObjectSchema",
    description: "Update an object schema's name/key/description.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      schemaId: z.string().min(1),
      name: z.string().optional(),
      objectSchemaKey: z.string().optional(),
      description: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      const before = await c.get<{ name?: string; objectSchemaKey?: string; description?: string }>(
        `/objectschema/${encodeURIComponent(input.schemaId)}`,
      );
      // PUT /objectschema/{id} is a REPLACE, not a partial update: name and
      // objectSchemaKey are mandatory on every call (the reverter below encodes the
      // same truth). Merge the supplied fields over the captured `before` so the body
      // is always a complete write shape — a partial body would 400 or blank fields.
      const prev = before.data ?? {};
      const name = input.name ?? prev.name;
      const objectSchemaKey = input.objectSchemaKey ?? prev.objectSchemaKey;
      if (!name || !objectSchemaKey)
        throw new ToolError(
          "VALIDATION_ERROR",
          "PUT /objectschema requires name and objectSchemaKey; the schema read returned neither, so pass them explicitly.",
        );
      const body: Record<string, unknown> = {
        name,
        objectSchemaKey,
        description: input.description ?? prev.description ?? "",
      };
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.updateObjectSchema",
        target: { kind: "asset_schema", id: input.schemaId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.updateObjectSchema",
        cloudId: ctx.cloudId,
        target: { kind: "asset_schema", id: input.schemaId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back to the same schema id.",
        run: async () => {
          const resp = await c.put<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // Object types
  defineTool({
    name: "assets.listObjectTypes",
    description: "List object types within a schema.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemaId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}/objecttypes/flat`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.getObjectType",
    description: "Get an object type by id.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectTypeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.createObjectType",
    description: "Create an object type inside a schema. Destructive — requires `commit:true`.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      schemaId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      iconId: z.string().min(1).describe("Required by POST /objecttype/create. See GET /icon/global for ids."),
      inherited: z.boolean().optional(),
      parentObjectTypeId: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const body: Record<string, unknown> = {
        name: input.name,
        description: input.description,
        iconId: input.iconId,
        inherited: input.inherited,
        parentObjectTypeId: input.parentObjectTypeId,
        objectSchemaId: input.schemaId,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.createObjectType",
        target: { kind: "asset_object_type", name: input.name, parent: input.schemaId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.createObjectType",
        cloudId: ctx.cloudId,
        target: { kind: "asset_object_type", name: input.name, parent: input.schemaId },
        before: null,
        request: body,
        revertible: false,
        run: async () => {
          const resp = await ctx.client.assets(ws).post<unknown>("/objecttype/create", body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, objectType: entry.after };
    },
  }),
  defineTool({
    name: "assets.updateObjectType",
    description: "Update an object type.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      objectTypeId: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      iconId: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      const before = await c.get<{ name?: string; description?: string; icon?: { id?: string | number } }>(
        `/objecttype/${encodeURIComponent(input.objectTypeId)}`,
      );
      // PUT /objecttype/{id} is a REPLACE, not a partial update: name and iconId are
      // mandatory on every call. Merge the supplied fields over the captured `before`,
      // projecting the read shape onto the write shape exactly as the reverter does —
      // the read nests the icon (`icon.id`), the PUT takes a flat `iconId`.
      const prev = before.data ?? {};
      const name = input.name ?? prev.name;
      const iconId = input.iconId ?? (prev.icon?.id !== undefined ? String(prev.icon.id) : undefined);
      if (!name || !iconId)
        throw new ToolError(
          "VALIDATION_ERROR",
          "PUT /objecttype requires name and iconId; the object type read returned neither, so pass them explicitly.",
        );
      const body: Record<string, unknown> = {
        name,
        description: input.description ?? prev.description ?? "",
        iconId,
      };
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.updateObjectType",
        target: { kind: "asset_object_type", id: input.objectTypeId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.updateObjectType",
        cloudId: ctx.cloudId,
        target: { kind: "asset_object_type", id: input.objectTypeId },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "assets.getObjectTypeAttributes",
    description: "List attributes of an object type.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectTypeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}/attributes`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.createObjectTypeAttribute",
    description: "Add an attribute to an object type.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      objectTypeId: z.string().min(1),
      attribute: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.createObjectTypeAttribute",
        target: { kind: "asset_attribute", parent: input.objectTypeId, name: (input.attribute as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: input.attribute,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.createObjectTypeAttribute",
        cloudId: ctx.cloudId,
        target: { kind: "asset_attribute", parent: input.objectTypeId, name: (input.attribute as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { attribute: input.attribute } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          // Correct endpoint is POST /objecttypeattribute/{objectTypeId}
          // (the old /objecttype/{id}/attribute/create is a Data Center path).
          const resp = await ctx.client
            .assets(ws)
            .post<unknown>(`/objecttypeattribute/${encodeURIComponent(input.objectTypeId)}`, input.attribute);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, attribute: entry.after };
    },
  }),
  defineTool({
    name: "assets.updateObjectTypeAttribute",
    description: "Update an attribute on an object type.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      objectTypeId: z.string().min(1).describe("The object type the attribute belongs to (required in the path)."),
      attributeId: z.string().min(1),
      attribute: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      // No single-attribute GET exists; capture the attribute from the object
      // type's attribute list for the before-snapshot.
      const attrs = await c.get<Array<{ id?: string | number }>>(
        `/objecttype/${encodeURIComponent(input.objectTypeId)}/attributes`,
      );
      const before = (attrs.data ?? []).find((a) => String(a.id) === String(input.attributeId)) ?? null;
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.updateObjectTypeAttribute",
        target: { kind: "asset_attribute", id: input.attributeId, parent: input.objectTypeId },
        before,
        after: input.attribute,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.updateObjectTypeAttribute",
        cloudId: ctx.cloudId,
        target: { kind: "asset_attribute", id: input.attributeId, parent: input.objectTypeId },
        before,
        request: { attribute: input.attribute } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          // Correct path requires both objectTypeId and the attribute id.
          const resp = await c.put<unknown>(
            `/objecttypeattribute/${encodeURIComponent(input.objectTypeId)}/${encodeURIComponent(input.attributeId)}`,
            input.attribute,
          );
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "assets.aqlSearch",
    description: "AQL (Assets Query Language) search.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      qlQuery: z.string().min(1),
      page: z.number().int().positive().default(1).optional(),
      resultPerPage: z.number().int().positive().max(500).default(25).optional(),
      includeAttributes: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      // The old GET /aql/objects was removed (Sept 2024). Current endpoint is
      // POST /object/aql with the query in the body and paging in query params.
      const p = new URLSearchParams({
        startAt: String(((input.page ?? 1) - 1) * (input.resultPerPage ?? 25)),
        maxResults: String(input.resultPerPage ?? 25),
        includeAttributes: String(input.includeAttributes ?? true),
      });
      const resp = await ctx.client
        .assets(ws)
        .post<unknown>(`/object/aql?${p.toString()}`, { qlQuery: input.qlQuery });
      return resp.data;
    },
  }),

  // Object CRUD
  defineTool({
    name: "assets.getObject",
    description: "Get an Assets object by id.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.createObject",
    description: "Create an Assets object.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      objectTypeId: z.string().min(1),
      attributes: z.array(z.record(z.string(), z.unknown())).min(1),
      hasAvatar: z.boolean().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const body = {
        objectTypeId: input.objectTypeId,
        attributes: input.attributes,
        hasAvatar: input.hasAvatar ?? false,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.createObject",
        target: { kind: "asset_object", parent: input.objectTypeId },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.createObject",
        cloudId: ctx.cloudId,
        target: { kind: "asset_object", parent: input.objectTypeId },
        before: null,
        request: body as Record<string, unknown>,
        revertible: false,
        run: async () => {
          const resp = await ctx.client.assets(ws).post<unknown>("/object/create", body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, object: entry.after };
    },
  }),
  defineTool({
    name: "assets.updateObject",
    description: "Update an Assets object's attributes.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      objectId: z.string().min(1),
      attributes: z.array(z.record(z.string(), z.unknown())).min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      const before = await c.get<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
      const after = { ...(before.data as object), attributes: input.attributes };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.updateObject",
        target: { kind: "asset_object", id: input.objectId },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.updateObject",
        cloudId: ctx.cloudId,
        target: { kind: "asset_object", id: input.objectId },
        before: before.data,
        request: { attributes: input.attributes } as Record<string, unknown>,
        revertible: true,
        revertHint: "PUT the captured `before.attributes` back.",
        run: async () => {
          const resp = await c.put<unknown>(`/object/${encodeURIComponent(input.objectId)}`, { attributes: input.attributes });
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "assets.deleteObject",
    description: "Delete an Assets object. Irreversible.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { objectId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      const before = await c.get<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "assets.deleteObject",
          target: { kind: "asset_object", id: input.objectId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.deleteObject",
        cloudId: ctx.cloudId,
        target: { kind: "asset_object", id: input.objectId },
        before: before.data,
        request: { objectId: input.objectId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
          return { deleted: input.objectId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  // References
  defineTool({
    name: "assets.getObjectReferences",
    description: "List references for an Assets object.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/object/${encodeURIComponent(input.objectId)}/referenceinfo`);
      return resp.data;
    },
  }),
  // NOTE: There is no /object/{id}/reference endpoint in cloud Assets — outbound
  // references are VALUES of reference-typed attributes. To add/remove a
  // reference, use assets.updateObject and set (or clear) the objectId list on
  // the appropriate reference attribute. The read tool getObjectReferences uses
  // the valid /referenceinfo endpoint and is kept above.

  defineTool({
    name: "assets.getObjectAttachments",
    description: "List attachments on an Assets object.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/attachments/object/${encodeURIComponent(input.objectId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "assets.getObjectHistory",
    description: "Get the change history for an Assets object.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { objectId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const resp = await ctx.client.assets(ws).get<unknown>(`/object/${encodeURIComponent(input.objectId)}/history`);
      return resp.data;
    },
  }),

  defineTool({
    name: "assets.startImport",
    description:
      "Trigger a pre-configured Assets import by its import id. The import (source, mapping, schedule) " +
      "is configured in the Assets UI; the API only starts it — there is no CSV-upload endpoint.",
    group: "write_assets",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      importId: z.string().min(1).describe("The configured import's id (from the Assets import UI)."),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "assets.startImport",
        target: { kind: "asset_import", id: input.importId },
        before: null,
        after: { importId: input.importId },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "assets.startImport",
        cloudId: ctx.cloudId,
        target: { kind: "asset_import", id: input.importId },
        before: null,
        request: { importId: input.importId } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          // Correct endpoint: POST /import/start/{id} (id in path, empty body).
          const resp = await ctx.client.assets(ws).post<unknown>(`/import/start/${encodeURIComponent(input.importId)}`);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, run: entry.after };
    },
  }),

  defineTool({
    name: "assets.exportAssetSchema",
    description: "Export a schema's full definition as JSON. Useful for backup before destructive ops.",
    group: "read_assets",
    authMethod: "oauth",
    needsCloudId: true,
    input: { schemaId: z.string().min(1) },
    handler: async (input, ctx) => {
      const ws = await workspace(ctx);
      const c = ctx.client.assets(ws);
      const [schema, types, attrs] = await Promise.all([
        c.get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`),
        c.get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}/objecttypes/flat`),
        c.get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}/attributes`),
      ]);
      return {
        schema: schema.data,
        objectTypes: types.data,
        attributes: attrs.data,
        exported_at: new Date().toISOString(),
      };
    },
  }),
];

/**
 * Reverters. No workspaceId is journaled: each reverter re-resolves it with the
 * same workspace(ctx) the handlers use. revertOperation refuses cross-cloudId
 * reverts and runs with the caller's own OAuth grant — exactly what discovery
 * needs — so the resolved workspace is the one the original op ran against.
 */

// PUT /objectschema/{id} requires name and objectSchemaKey; `description` is
// always sent (defaulting to "") so one the update ADDED is cleared, not kept.
reverters.register("assets.updateObjectSchema", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: object schema id missing from target.");
  const before = entry.before as { name?: string; objectSchemaKey?: string; description?: string } | null;
  if (!before?.name || !before.objectSchemaKey)
    throw new Error("Cannot revert: journal entry has no captured `before` schema name/key.");
  const ws = await workspace(ctx);
  const resp = await ctx.client.assets(ws).put<unknown>(`/objectschema/${encodeURIComponent(id)}`, {
    name: before.name,
    objectSchemaKey: before.objectSchemaKey,
    description: before.description ?? "",
  });
  return { reverted: id, response: resp.data };
});

// The object-type READ shape nests the icon (`icon.id`), but PUT /objecttype/{id}
// takes a flat, required `iconId` — project it back, or the revert 400s.
reverters.register("assets.updateObjectType", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: object type id missing from target.");
  const before = entry.before as { name?: string; description?: string; icon?: { id?: string | number } } | null;
  if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` object type name.");
  const body: Record<string, unknown> = { name: before.name, description: before.description ?? "" };
  if (before.icon?.id !== undefined) body.iconId = String(before.icon.id);
  const ws = await workspace(ctx);
  const resp = await ctx.client.assets(ws).put<unknown>(`/objecttype/${encodeURIComponent(id)}`, body);
  return { reverted: id, response: resp.data };
});

// The before-snapshot comes from the attribute LIST (read shape: nested
// `defaultType`, plus read-only ids that the write shape rejects), so project it
// onto the PUT body — the default type is a flat `defaultTypeId` there. The object
// type id rides on target.parent (it is a path param the attribute id lacks).
reverters.register("assets.updateObjectTypeAttribute", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const t = entry.target as { id?: string; parent?: string };
  if (!t.id || !t.parent) throw new Error("Cannot revert: attribute id or object type id missing from target.");
  const before = entry.before as Record<string, unknown> | null;
  if (!before)
    throw new Error("Cannot revert: journal entry has no captured `before` attribute (it was not on the object type).");
  const body: Record<string, unknown> = {};
  for (const k of [
    "name",
    "label",
    "type",
    "description",
    "typeValue",
    "typeValueMulti",
    "additionalValue",
    "minimumCardinality",
    "maximumCardinality",
    "suffix",
    "includeChildObjectTypes",
    "hidden",
    "uniqueAttribute",
    "summable",
    "regexValidation",
    "qlQuery",
    "iql",
    "options",
  ] as const) {
    if (before[k] !== undefined) body[k] = before[k];
  }
  const defaultTypeId = (before.defaultType as { id?: number } | undefined)?.id;
  if (defaultTypeId !== undefined) body.defaultTypeId = defaultTypeId;
  const ws = await workspace(ctx);
  const resp = await ctx.client
    .assets(ws)
    .put<unknown>(`/objecttypeattribute/${encodeURIComponent(t.parent)}/${encodeURIComponent(t.id)}`, body);
  return { reverted: t.id, response: resp.data };
});

type AssetAttributeValue = { value?: unknown; searchValue?: unknown; displayValue?: unknown };
type AssetAttribute = { objectTypeAttributeId?: unknown; objectAttributeValues?: AssetAttributeValue[] };

// Reverting an object update = write the PRIOR values of exactly the attributes
// the update wrote (so read-only system attributes like Key/Created are never
// touched). The object READ shape carries values as {value, displayValue,
// searchValue, …} while the write shape wants
// [{objectTypeAttributeId, objectAttributeValues:[{value}]}]; an attribute missing
// from `before` had no value, so the empty value list clears what the update added.
reverters.register("assets.updateObject", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: object id missing from target.");
  const before = entry.before as { attributes?: AssetAttribute[] } | null;
  if (!before) throw new Error("Cannot revert: journal entry has no captured `before` object.");
  const written = (entry.request as { attributes?: AssetAttribute[] }).attributes ?? [];
  if (written.length === 0) throw new Error("Cannot revert: journal entry recorded no attributes to restore.");
  const prior = new Map((before.attributes ?? []).map((a) => [String(a.objectTypeAttributeId), a]));
  const attributes = written.map((a) => {
    const attrId = String(a.objectTypeAttributeId);
    const values = prior.get(attrId)?.objectAttributeValues ?? [];
    return {
      objectTypeAttributeId: attrId,
      objectAttributeValues: values.map((v) => ({ value: v.value ?? v.searchValue ?? v.displayValue })),
    };
  });
  const ws = await workspace(ctx);
  const resp = await ctx.client.assets(ws).put<unknown>(`/object/${encodeURIComponent(id)}`, { attributes });
  return { reverted: id, response: resp.data };
});

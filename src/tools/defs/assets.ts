import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDryRunIfNotCommitted } from "../../consent/dryRun.js";
import { getAssetsWorkspaceId } from "../../atlassian/assetsWorkspace.js";
import { ToolError } from "../../middleware/errorHandler.js";
import { AQL_TABLE_UI_URI } from "../../ui/appResources.js";
import type { ToolContext } from "../types.js";

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
 * the app. The full set this surface needs:
 *   read/write:cmdb-object:jira, read/write:cmdb-schema:jira,
 *   read/write:cmdb-type:jira, read/write:cmdb-attribute:jira (the 8 core), plus
 *   delete:cmdb-object:jira, delete:cmdb-schema:jira, delete:cmdb-type:jira,
 *   delete:cmdb-attribute:jira (assets.delete) and
 *   import:import-configuration:cmdb (assets.startImport).
 * NOTE: endpoints/scopes below were cross-checked against the Assets OpenAPI
 * spec but NOT live-CRUD-verified — the dev site is JSM Free (Assets needs
 * Premium; every data-plane call 403s "Access to Assets API was denied").
 */

async function workspace(ctx: ToolContext): Promise<string> {
  if (!ctx.cloudId) throw new ToolError("VALIDATION_ERROR", "cloudId required for Assets calls");
  // Discovery requires OAuth + JSM scopes.
  if (!ctx.storedToken)
    throw new ToolError(
      "AUTH_REQUIRED",
      "Assets workspace discovery requires an OAuth grant with JSM scopes; the bound API token alone is insufficient for discovery.",
    );
  return getAssetsWorkspaceId(ctx.redis, ctx.cloudId, ctx.storedToken.access_token);
}

// Hoisted shared field schemas.
const schemaId = z.string().min(1).describe("Object schema id");
const objectTypeId = z.string().min(1).describe("Object type id");
const objectId = z.string().min(1).describe("Assets object id");
const attributeId = z.string().min(1).describe("Object type attribute id");
const assetName = z.string().min(1).describe("Name (of the schema or object type, per op)");
const assetDescription = z.string().describe("Description");
const objectSchemaKey = z.string().min(1).describe("Schema key (short uppercase identifier)");
const iconId = z.string().min(1).describe("Icon id (see GET /icon/global for ids)");
const attributeDefinition = z
  .record(z.string(), z.unknown())
  .describe("The attribute DEFINITION object (name, type, typeValue, cardinality...)");
const objectAttributeValues = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .describe("Attribute VALUE entries: [{objectTypeAttributeId, objectAttributeValues:[{value}]}]");

const assetsReadSchema = defineOpTool({
  name: "assets.readSchema",
  description:
    "Browse Assets schema structure: list object schemas (listObjectSchemas), get one (getObjectSchema), list a schema's object types (listObjectTypes), get one type (getObjectType), list a type's attributes (getObjectTypeAttributes), or export a full schema definition as JSON (exportAssetSchema).",
  group: "read_assets",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listObjectSchemas",
      description: "List Assets object schemas in this workspace.",
      legacyName: "assets.listObjectSchemas",
      handler: async (_input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).get<unknown>("/objectschema/list");
        return resp.data;
      },
    }),
    defineOp({
      op: "getObjectSchema",
      description: "Get a single object schema by id.",
      legacyName: "assets.getObjectSchema",
      input: { schemaId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listObjectTypes",
      description: "List object types within a schema (schemaId is the PARENT here).",
      legacyName: "assets.listObjectTypes",
      input: { schemaId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client
          .assets(ws)
          .get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}/objecttypes/flat`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getObjectType",
      description: "Get an object type by id.",
      legacyName: "assets.getObjectType",
      input: { objectTypeId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getObjectTypeAttributes",
      description: "List attributes of an object type (objectTypeId is the PARENT here).",
      legacyName: "assets.getObjectTypeAttributes",
      input: { objectTypeId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client
          .assets(ws)
          .get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}/attributes`);
        return resp.data;
      },
    }),
    defineOp({
      op: "exportAssetSchema",
      description: "Export a schema's full definition as JSON. Useful for backup before destructive ops.",
      legacyName: "assets.exportAssetSchema",
      input: { schemaId },
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
  ],
});

const assetsReadObject = defineOpTool({
  name: "assets.readObject",
  description:
    "Read a single Assets object: its data (getObject), its references (getObjectReferences), or its change history (getObjectHistory). Use assets.aqlSearch to query objects.",
  group: "read_assets",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "getObject",
      description: "Get an Assets object by id.",
      legacyName: "assets.getObject",
      input: { objectId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).get<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getObjectReferences",
      description:
        "List references for an Assets object. (Outbound references are VALUES of reference-typed attributes; change them via assets.manageObject updateObject.)",
      legacyName: "assets.getObjectReferences",
      input: { objectId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client
          .assets(ws)
          .get<unknown>(`/object/${encodeURIComponent(input.objectId)}/referenceinfo`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getObjectHistory",
      description: "Get the change history for an Assets object.",
      legacyName: "assets.getObjectHistory",
      input: { objectId },
      handler: async (input, ctx) => {
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).get<unknown>(`/object/${encodeURIComponent(input.objectId)}/history`);
        return resp.data;
      },
    }),
  ],
});

// Keeper: the AQL table template hardcodes this name and reads qlQuery/page
// from top-level args — forced standalone (and the canonical rule-3 split).
const assetsAqlSearch = defineTool({
  name: "assets.aqlSearch",
  description: "AQL (Assets Query Language) search.",
  group: "read_assets",
  authMethod: "oauth",
  needsCloudId: true,
  readOnly: true,
  ui: { resourceUri: AQL_TABLE_UI_URI },
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
    const resp = await ctx.client.assets(ws).post<unknown>(`/object/aql?${p.toString()}`, { qlQuery: input.qlQuery });
    return resp.data;
  },
});

const assetsManageSchema = defineOpTool({
  name: "assets.manageSchema",
  description:
    "Model Assets schemas: create/update an object schema (createObjectSchema, updateObjectSchema), an object type (createObjectType, updateObjectType), or an object type attribute definition (createObjectTypeAttribute, updateObjectTypeAttribute).",
  group: "write_assets",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createObjectSchema",
      description: "Create a new object schema.",
      destructive: true,
      legacyName: "assets.createObjectSchema",
      input: {
        name: assetName,
        objectSchemaKey,
        description: assetDescription.optional(),
      },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const body = {
          name: input.name,
          objectSchemaKey: input.objectSchemaKey,
          description: input.description,
        };
        const dry = meta.dryRun({
          target: { kind: "asset_schema", name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "updateObjectSchema",
      description: "Update an object schema's name/key/description. Revertible.",
      destructive: true,
      legacyName: "assets.updateObjectSchema",
      input: {
        schemaId,
        name: assetName.optional(),
        objectSchemaKey: objectSchemaKey.optional(),
        description: assetDescription.optional(),
      },
      handler: async (input, ctx, meta) => {
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
        const key = input.objectSchemaKey ?? prev.objectSchemaKey;
        if (!name || !key)
          throw new ToolError(
            "VALIDATION_ERROR",
            "PUT /objectschema requires name and objectSchemaKey; the schema read returned neither, so pass them explicitly.",
          );
        const body: Record<string, unknown> = {
          name,
          objectSchemaKey: key,
          description: input.description ?? prev.description ?? "",
        };
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "asset_schema", id: input.schemaId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // PUT /objectschema/{id} requires name and objectSchemaKey; `description` is
      // always sent (defaulting to "") so one the update ADDED is cleared, not kept.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
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
      },
    }),
    defineOp({
      op: "createObjectType",
      description: "Create an object type inside a schema (schemaId is the PARENT; iconId required).",
      destructive: true,
      legacyName: "assets.createObjectType",
      input: {
        schemaId,
        name: assetName,
        description: assetDescription.optional(),
        iconId,
        inherited: z.boolean().optional(),
        parentObjectTypeId: z.string().optional().describe("Parent object type for hierarchy"),
      },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const body: Record<string, unknown> = {
          name: input.name,
          description: input.description,
          iconId: input.iconId,
          inherited: input.inherited,
          parentObjectTypeId: input.parentObjectTypeId,
          objectSchemaId: input.schemaId,
        };
        const dry = meta.dryRun({
          target: { kind: "asset_object_type", name: input.name, parent: input.schemaId },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "updateObjectType",
      description: "Update an object type's name/description/icon. Revertible.",
      destructive: true,
      legacyName: "assets.updateObjectType",
      input: {
        objectTypeId,
        name: assetName.optional(),
        description: assetDescription.optional(),
        iconId: iconId.optional(),
      },
      handler: async (input, ctx, meta) => {
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
        const icon = input.iconId ?? (prev.icon?.id !== undefined ? String(prev.icon.id) : undefined);
        if (!name || !icon)
          throw new ToolError(
            "VALIDATION_ERROR",
            "PUT /objecttype requires name and iconId; the object type read returned neither, so pass them explicitly.",
          );
        const body: Record<string, unknown> = {
          name,
          description: input.description ?? prev.description ?? "",
          iconId: icon,
        };
        const after = { ...(before.data as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "asset_object_type", id: input.objectTypeId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // The object-type READ shape nests the icon (`icon.id`), but PUT
      // /objecttype/{id} takes a flat, required `iconId` — project it back, or
      // the revert 400s.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: object type id missing from target.");
        const before = entry.before as { name?: string; description?: string; icon?: { id?: string | number } } | null;
        if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` object type name.");
        const body: Record<string, unknown> = { name: before.name, description: before.description ?? "" };
        if (before.icon?.id !== undefined) body.iconId = String(before.icon.id);
        const ws = await workspace(ctx);
        const resp = await ctx.client.assets(ws).put<unknown>(`/objecttype/${encodeURIComponent(id)}`, body);
        return { reverted: id, response: resp.data };
      },
    }),
    defineOp({
      op: "createObjectTypeAttribute",
      description: "Add an attribute definition to an object type (objectTypeId is the PARENT).",
      destructive: true,
      legacyName: "assets.createObjectTypeAttribute",
      input: { objectTypeId, attribute: attributeDefinition },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const target = {
          kind: "asset_attribute",
          parent: input.objectTypeId,
          name: (input.attribute as { name?: string }).name ?? "(unnamed)",
        };
        const dry = meta.dryRun({ target, before: null, after: input.attribute });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target,
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
    defineOp({
      op: "updateObjectTypeAttribute",
      description: "Update an attribute definition on an object type. Revertible.",
      destructive: true,
      legacyName: "assets.updateObjectTypeAttribute",
      input: { objectTypeId, attributeId, attribute: attributeDefinition },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        // No single-attribute GET exists; capture the attribute from the object
        // type's attribute list for the before-snapshot.
        const attrs = await c.get<Array<{ id?: string | number }>>(
          `/objecttype/${encodeURIComponent(input.objectTypeId)}/attributes`,
        );
        const before = (attrs.data ?? []).find((a) => String(a.id) === String(input.attributeId)) ?? null;
        const dry = meta.dryRun({
          target: { kind: "asset_attribute", id: input.attributeId, parent: input.objectTypeId },
          before,
          after: input.attribute,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // The before-snapshot comes from the attribute LIST (read shape: nested
      // `defaultType`, plus read-only ids that the write shape rejects), so
      // project it onto the PUT body — the default type is a flat
      // `defaultTypeId` there. The object type id rides on target.parent (it is
      // a path param the attribute id lacks).
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const t = entry.target as { id?: string; parent?: string };
        if (!t.id || !t.parent) throw new Error("Cannot revert: attribute id or object type id missing from target.");
        const before = entry.before as Record<string, unknown> | null;
        if (!before)
          throw new Error(
            "Cannot revert: journal entry has no captured `before` attribute (it was not on the object type).",
          );
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
      },
    }),
  ],
});

type AssetAttributeValue = { value?: unknown; searchValue?: unknown; displayValue?: unknown };
type AssetAttribute = { objectTypeAttributeId?: unknown; objectAttributeValues?: AssetAttributeValue[] };

const assetsManageObject = defineOpTool({
  name: "assets.manageObject",
  description:
    "Create an Assets object with attribute values (createObject) or update an object's attribute values (updateObject — revertible).",
  group: "write_assets",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createObject",
      description: "Create an Assets object (objectTypeId is the PARENT type).",
      destructive: true,
      legacyName: "assets.createObject",
      input: {
        objectTypeId,
        attributes: objectAttributeValues,
        hasAvatar: z.boolean().optional(),
      },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const body = {
          objectTypeId: input.objectTypeId,
          attributes: input.attributes,
          hasAvatar: input.hasAvatar ?? false,
        };
        const dry = meta.dryRun({
          target: { kind: "asset_object", parent: input.objectTypeId },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "updateObject",
      description: "Update an Assets object's attribute values. Revertible (restores the prior values of exactly the touched attributes).",
      destructive: true,
      legacyName: "assets.updateObject",
      input: { objectId, attributes: objectAttributeValues },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        const before = await c.get<{ objectType?: { id?: string | number } }>(
          `/object/${encodeURIComponent(input.objectId)}`,
        );
        // The PUT schema marks objectTypeId required; Atlassian doesn't currently
        // enforce it, but send it (from the object's own type) so we don't break
        // if they ever do. The object's type never changes on an attribute update.
        const typeId = before.data.objectType?.id != null ? String(before.data.objectType.id) : undefined;
        const putBody = { objectTypeId: typeId, attributes: input.attributes };
        const after = { ...(before.data as object), attributes: input.attributes };
        const dry = meta.dryRun({
          target: { kind: "asset_object", id: input.objectId },
          before: before.data,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "asset_object", id: input.objectId },
          before: before.data,
          request: { attributes: input.attributes } as Record<string, unknown>,
          revertible: true,
          revertHint: "PUT the captured `before.attributes` back.",
          run: async () => {
            const resp = await c.put<unknown>(`/object/${encodeURIComponent(input.objectId)}`, putBody);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
      // Reverting an object update = write the PRIOR values of exactly the
      // attributes the update wrote (so read-only system attributes like
      // Key/Created are never touched). The object READ shape carries values as
      // {value, displayValue, searchValue, …} while the write shape wants
      // [{objectTypeAttributeId, objectAttributeValues:[{value}]}]; an attribute
      // missing from `before` had no value, so the empty value list clears what
      // the update added.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: object id missing from target.");
        const before = entry.before as { attributes?: AssetAttribute[]; objectType?: { id?: string | number } } | null;
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
        // Send objectTypeId (schema marks it required) from the captured object.
        const typeId = before.objectType?.id != null ? String(before.objectType.id) : undefined;
        const ws = await workspace(ctx);
        const resp = await ctx.client
          .assets(ws)
          .put<unknown>(`/object/${encodeURIComponent(id)}`, { objectTypeId: typeId, attributes });
        return { reverted: id, response: resp.data };
      },
    }),
  ],
});

const assetsDelete = defineOpTool({
  name: "assets.delete",
  description:
    "Destructive Assets deletions: an object schema — cascades to ALL its types and objects, export first (deleteObjectSchema); an object type and its objects (deleteObjectType); an object type attribute (deleteObjectTypeAttribute); or a single object (deleteObject). All irreversible.",
  group: "write_assets",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "deleteObjectSchema",
      description:
        "Delete an object schema and everything in it (types, objects). Irreversible and heavy — the whole schema definition is captured in the journal `before`. Export it first with assets.readSchema exportAssetSchema.",
      destructive: true,
      legacyName: "assets.deleteObjectSchema",
      input: { schemaId },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        const before = await c.get<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "asset_object_schema", id: input.schemaId },
            before: before.data,
            message: "This DELETES the schema and ALL its object types and objects. Irreversible.",
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "asset_object_schema", id: input.schemaId },
          before: before.data,
          request: { schemaId: input.schemaId } as Record<string, unknown>,
          revertible: false,
          run: async () => {
            await c.delete<unknown>(`/objectschema/${encodeURIComponent(input.schemaId)}`);
            return { deleted: input.schemaId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
    defineOp({
      op: "deleteObjectType",
      description: "Delete an object type (and its objects). Irreversible — the type definition is captured in the journal.",
      destructive: true,
      legacyName: "assets.deleteObjectType",
      input: { objectTypeId },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        const before = await c.get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "asset_object_type", id: input.objectTypeId },
            before: before.data,
            message: "This DELETES the object type and its objects. Irreversible.",
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "asset_object_type", id: input.objectTypeId },
          before: before.data,
          request: { objectTypeId: input.objectTypeId } as Record<string, unknown>,
          revertible: false,
          run: async () => {
            await c.delete<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}`);
            return { deleted: input.objectTypeId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
    defineOp({
      op: "deleteObjectTypeAttribute",
      description:
        "Delete an attribute from an object type by attribute id. Irreversible. (There is no single-attribute GET, so the journal captures the object type's full attribute list as `before` for reconstruction.)",
      destructive: true,
      legacyName: "assets.deleteObjectTypeAttribute",
      input: {
        objectTypeId,
        attributeId,
      },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        // No single-attribute GET — snapshot the type's attribute list instead.
        const list = await c.get<unknown>(`/objecttype/${encodeURIComponent(input.objectTypeId)}/attributes`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "asset_object_type_attribute", id: input.attributeId },
            before: list.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "asset_object_type_attribute", id: input.attributeId },
          before: list.data,
          request: { objectTypeId: input.objectTypeId, attributeId: input.attributeId } as Record<string, unknown>,
          revertible: false,
          run: async () => {
            // DELETE /objecttypeattribute/{id} — attribute id only (no objectTypeId in path).
            await c.delete<unknown>(`/objecttypeattribute/${encodeURIComponent(input.attributeId)}`);
            return { deleted: input.attributeId };
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
    }),
    defineOp({
      op: "deleteObject",
      description: "Delete an Assets object. Irreversible.",
      destructive: true,
      legacyName: "assets.deleteObject",
      input: { objectId },
      handler: async (input, ctx, meta) => {
        const ws = await workspace(ctx);
        const c = ctx.client.assets(ws);
        const before = await c.get<unknown>(`/object/${encodeURIComponent(input.objectId)}`);
        if (input.commit !== true) {
          return meta.deleteDryRun({
            target: { kind: "asset_object", id: input.objectId },
            before: before.data,
          });
        }
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
  ],
});

// Keeper: not CRUD — a job trigger with its own operational contract.
const assetsStartImport = defineTool({
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
      ...ctx.defaultJournalArgs,
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
});

export const assetsTools = (): AnyToolDef[] => [
  assetsReadSchema,
  assetsReadObject,
  assetsAqlSearch,
  assetsManageSchema,
  assetsManageObject,
  assetsDelete,
  assetsStartImport,
];

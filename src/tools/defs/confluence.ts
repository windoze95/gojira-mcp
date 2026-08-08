import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";
import type { ToolContext } from "../types.js";

/**
 * Confluence admin tools (spaces, permissions, templates, blueprints,
 * content restrictions), via the **site host + per-user API token (Basic)** —
 * ctx.client.apiTokenJira(), paths under /wiki.
 *
 * Why not OAuth (verified live against the dev tenant): on the OAuth host
 * (api.atlassian.com/ex/confluence/{cloudId}) the v2 space reads 401 unless the
 * app declares GRANULAR scopes, and the v1 space API — which the space
 * create/update/delete and template/restriction tools depend on — returns
 * **410 Gone** outright. The site host accepts the bound API token via Basic
 * auth for BOTH v1 and v2 (200s), with no OAuth scopes involved, so this is
 * the only credential that can run the full surface.
 *
 * v1/v2 nuance that still applies: the v1 space GET is deprecated, so
 * before-snapshots come from v2 (`spaceBeforeSnapshot`).
 */
const V2 = "/wiki/api/v2";
const V1 = "/wiki/rest/api";

/**
 * Read a space's current state via v2 (the v1 GET was removed). Returns the first
 * match or null.
 *
 * `description-format=plain` is not optional: without it v2 omits `description`
 * entirely, and the update reverter rebuilds its v1 PUT body from this snapshot —
 * a snapshot with no description could not restore one.
 */
async function spaceBeforeSnapshot(ctx: ToolContext, spaceKey: string): Promise<unknown> {
  const resp = await ctx.client
    .apiTokenJira()
    .get<{ results?: unknown[] }>(`${V2}/spaces?keys=${encodeURIComponent(spaceKey)}&description-format=plain`);
  return resp.data.results?.[0] ?? null;
}

// Hoisted shared field schemas. Two id vocabularies exist deliberately:
// v2 ops address spaces by numeric spaceId; v1 ops (writes, templates) by key.
const spaceId = z.string().min(1).describe("Confluence v2 numeric space id");
const spaceKeyFilter = z.string().describe("Space KEY (v1 vocabulary)");

const confluenceReadSpace = defineOpTool({
  name: "confluence.readSpace",
  description:
    "Read Confluence spaces: list spaces (listConfluenceSpaces), get one space by v2 spaceId (getConfluenceSpace), list a space's permissions (listSpacePermissions).",
  group: "read_confluence_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listConfluenceSpaces",
      description: "List Confluence spaces (cursor-paged), filterable by type/status.",
      legacyName: "confluence.listConfluenceSpaces",
      input: {
        cursor: z.string().optional().describe("Cursor from the previous page"),
        limit: z.number().int().positive().max(250).default(25).optional(),
        type: z.enum(["global", "personal"]).optional(),
        status: z.enum(["current", "archived"]).optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({ limit: String(input.limit ?? 25) });
        if (input.cursor) p.set("cursor", input.cursor);
        if (input.type) p.set("type", input.type);
        if (input.status) p.set("status", input.status);
        const resp = await ctx.client.apiTokenJira().get<unknown>(`${V2}/spaces?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getConfluenceSpace",
      description: "Get a single Confluence space by v2 spaceId.",
      legacyName: "confluence.getConfluenceSpace",
      input: { spaceId },
      handler: async (input, ctx) => {
        const resp = await ctx.client.apiTokenJira().get<unknown>(`${V2}/spaces/${encodeURIComponent(input.spaceId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listSpacePermissions",
      description: "List permissions on a Confluence space (by v2 spaceId).",
      legacyName: "confluence.listSpacePermissions",
      input: { spaceId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${V2}/spaces/${encodeURIComponent(input.spaceId)}/permissions`);
        return resp.data;
      },
    }),
  ],
});

const confluenceReadContent = defineOpTool({
  name: "confluence.readContent",
  description:
    "Read Confluence content configuration: list page templates (listTemplates), list blueprints (listBlueprints), get a content item's read/update restrictions (getContentRestrictions).",
  group: "read_confluence_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listTemplates",
      description: "List Confluence templates available globally or in a specific space (by space KEY).",
      legacyName: "confluence.listTemplates",
      input: {
        spaceKey: spaceKeyFilter.optional(),
        startAt: z.number().int().nonnegative().default(0).optional().describe("Page offset"),
        maxResults: z.number().int().positive().max(100).default(25).optional().describe("Page size"),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          start: String(input.startAt ?? 0),
          limit: String(input.maxResults ?? 25),
        });
        if (input.spaceKey) p.set("spaceKey", input.spaceKey);
        const resp = await ctx.client.apiTokenJira().get<unknown>(`${V1}/template/page?${p.toString()}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "listBlueprints",
      description: "List Confluence blueprints (built-in page templates), optionally scoped to a space KEY.",
      legacyName: "confluence.listBlueprints",
      input: { spaceKey: spaceKeyFilter.optional() },
      handler: async (input, ctx) => {
        const p = new URLSearchParams();
        if (input.spaceKey) p.set("spaceKey", input.spaceKey);
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${V1}/template/blueprint${p.toString() ? `?${p.toString()}` : ""}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getContentRestrictions",
      description: "Get the read/update restrictions on a piece of content.",
      legacyName: "confluence.getContentRestrictions",
      input: { contentId: z.string().min(1).describe("Content id") },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .apiTokenJira()
          .get<unknown>(`${V1}/content/${encodeURIComponent(input.contentId)}/restriction`);
        return resp.data;
      },
    }),
  ],
});

// One key vocabulary for the write tool: `spaceKey` names the space for BOTH
// ops (the create handler maps it onto the v1 API's `key` body field). The
// pre-collapse create tool called it `key`; the alias path keeps old journal
// entries revertible with the unchanged target.key reader.
const manageSpaceKey = z.string().min(1).max(255).describe("Space KEY");
const manageSpaceName = z.string().min(1).describe("Space name");
const manageSpaceDescription = z.string().describe("Space description (plain text)");

const confluenceManageSpace = defineOpTool({
  name: "confluence.manageSpace",
  description:
    "Create a Confluence space (createConfluenceSpace) or update its name/description (updateConfluenceSpace). Keyed by spaceKey; both revertible.",
  group: "write_confluence_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createConfluenceSpace",
      description: "Create a Confluence space (spaceKey becomes the v1 API's key).",
      destructive: true,
      legacyName: "confluence.createConfluenceSpace",
      input: {
        spaceKey: manageSpaceKey,
        name: manageSpaceName,
        description: manageSpaceDescription.optional(),
      },
      handler: async (input, ctx, meta) => {
        const body = {
          key: input.spaceKey,
          name: input.name,
          description: input.description ? { plain: { value: input.description } } : undefined,
        };
        const dry = meta.dryRun({
          target: { kind: "confluence_space", key: input.spaceKey, name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "confluence_space", key: input.spaceKey, name: input.name },
          before: null,
          request: body as Record<string, unknown>,
          revertible: true,
          revertHint: "DELETE the created space (Confluence v1: rest/api/space/{key}).",
          deriveTargetId: (after) => (after as { id?: string | number })?.id?.toString(),
          run: async () => {
            const resp = await ctx.client.apiTokenJira().post<{ id: string }>(`${V1}/space`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId, space: entry.after };
      },
      // The space key rides on target.key in both eras (new entries journal it
      // from spaceKey; legacy entries journaled it from `key`).
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const key = (entry.target as { key?: string }).key;
        if (!key) throw new Error("Cannot revert: space key missing.");
        await ctx.client.apiTokenJira().delete<unknown>(`/wiki/rest/api/space/${encodeURIComponent(key)}`);
        return { deleted: key };
      },
    }),
    defineOp({
      op: "updateConfluenceSpace",
      description: "Update a Confluence space's name/description. Revertible.",
      destructive: true,
      legacyName: "confluence.updateConfluenceSpace",
      input: {
        spaceKey: manageSpaceKey,
        name: manageSpaceName.optional(),
        description: manageSpaceDescription.optional(),
      },
      handler: async (input, ctx, meta) => {
        const c = ctx.client.apiTokenJira();
        // v1 GET /space/{key} was removed (410); read current state from v2.
        const before = await spaceBeforeSnapshot(ctx, input.spaceKey);
        const body: Record<string, unknown> = {};
        if (input.name !== undefined) body.name = input.name;
        if (input.description !== undefined) body.description = { plain: { value: input.description } };
        const after = { ...(before as object), ...body };
        const dry = meta.dryRun({
          target: { kind: "confluence_space", id: input.spaceKey },
          before,
          after,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "confluence_space", id: input.spaceKey },
          before,
          // spaceKey is the path param the reverter needs; `body` alone is only the patch.
          request: { spaceKey: input.spaceKey, ...body },
          revertible: true,
          revertHint: "PUT the captured `before` payload back.",
          run: async () => {
            const resp = await c.put<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`, body);
            return resp.data;
          },
        });
        return { ok: true, journal_id: entry.opId };
      },
      // Reverting a space update = PUT the captured `before` back to the v1
      // endpoint. `before` is the v2 snapshot, so the v1 update body has to be
      // rebuilt from it: v2 nests the description under
      // `description.plain.value`, and v1 wants a full
      // { plain: { value, representation } }. The v1 PUT is a PARTIAL update,
      // so `description` is always sent (defaulting to "") — omitting it would
      // leave a newly-added description in place instead of clearing it.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const key = (entry.request as { spaceKey?: string } | null)?.spaceKey ?? (entry.target as { id?: string }).id;
        if (!key) throw new Error("Cannot revert: space key missing from the journal entry.");
        const before = entry.before as { name?: string; description?: { plain?: { value?: string } } } | null;
        // PUT /space/{key} requires `name`, so a snapshot without one is unusable.
        if (!before?.name) throw new Error("Cannot revert: journal entry has no captured `before` space name.");
        const body: Record<string, unknown> = {
          name: before.name,
          description: { plain: { value: before.description?.plain?.value ?? "", representation: "plain" } },
        };
        const resp = await ctx.client.apiTokenJira().put<unknown>(`${V1}/space/${encodeURIComponent(key)}`, body);
        return { reverted: key, response: resp.data };
      },
    }),
  ],
});

const confluenceDelete = defineTool({
  name: "confluence.delete",
  description: "Delete a Confluence space. **Irreversible.**",
  group: "write_confluence_admin",
  authMethod: "api_token",
  needsCloudId: true,
  destructive: true,
  legacyName: "confluence.deleteConfluenceSpace",
  input: { spaceKey: z.string().min(1), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    const c = ctx.client.apiTokenJira();
    // v1 GET /space/{key} was removed (410); read current state from v2.
    const before = await spaceBeforeSnapshot(ctx, input.spaceKey);
    if (input.commit !== true) {
      return buildDeleteDryRun({
        tool: "confluence.delete",
        target: { kind: "confluence_space", id: input.spaceKey },
        before,
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
      target: { kind: "confluence_space", id: input.spaceKey },
      before,
      request: { spaceKey: input.spaceKey } as Record<string, unknown>,
      revertible: false,
      run: async () => {
        await c.delete<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`);
        return { deleted: input.spaceKey };
      },
    });
    return { ok: true, journal_id: entry.opId };
  },
});

// Keeper: its `restrictions` record blob and empty→DELETE revert branch stay
// isolated from the space tools (rule 3 — no shared input shape).
const confluenceSetContentRestrictions = defineTool({
  name: "confluence.setContentRestrictions",
  description:
    "Replace restrictions on a piece of content. Requires a paid Confluence plan — the Free plan 403s restriction writes (reads work).",
  group: "write_confluence_admin",
  authMethod: "api_token",
  needsCloudId: true,
  destructive: true,
  input: {
    contentId: z.string().min(1),
    restrictions: z.array(z.record(z.string(), z.unknown())).min(1),
    commit: z.boolean().optional(),
  },
  handler: async (input, ctx) => {
    const c = ctx.client.apiTokenJira();
    const before = await c.get<unknown>(`${V1}/content/${encodeURIComponent(input.contentId)}/restriction`);
    const dry = buildDryRunIfNotCommitted(input, {
      tool: "confluence.setContentRestrictions",
      target: { kind: "content_restrictions", id: input.contentId },
      before: before.data,
      after: { restrictions: input.restrictions },
    });
    if (dry) return dry;
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
      target: { kind: "content_restrictions", id: input.contentId },
      before: before.data,
      request: { restrictions: input.restrictions } as Record<string, unknown>,
      revertible: true,
      revertHint: "Re-issue setContentRestrictions with the captured `before` restrictions.",
      run: async () => {
        const resp = await c.put<unknown>(`${V1}/content/${encodeURIComponent(input.contentId)}/restriction`, {
          results: input.restrictions,
        });
        return resp.data;
      },
    });
    return { ok: true, journal_id: entry.opId };
  },
});

export const confluenceAdminTools = (): AnyToolDef[] => [
  confluenceReadSpace,
  confluenceReadContent,
  confluenceManageSpace,
  confluenceDelete,
  confluenceSetContentRestrictions,
];

// Reverting a restriction replace = PUT the captured `before` restrictions back.
// `before` is the paginated GET body, whose `results` array is exactly the
// restriction list the PUT expects. An empty `results` means the content carried
// no restrictions at all, and DELETE — not a PUT of nothing — is the way back.
reverters.register("confluence.setContentRestrictions", async (entry, anyCtx) => {
  const ctx = anyCtx as ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: content id missing from the journal entry.");
  const before = entry.before as { results?: unknown[] } | null;
  if (!before) throw new Error("Cannot revert: journal entry has no captured `before` restrictions.");
  const c = ctx.client.apiTokenJira();
  const path = `${V1}/content/${encodeURIComponent(id)}/restriction`;
  const results = before.results ?? [];
  if (results.length === 0) {
    await c.delete<unknown>(path);
    return { reverted: id, restrictions: "cleared" };
  }
  const resp = await c.put<unknown>(path, { results });
  return { reverted: id, response: resp.data };
});

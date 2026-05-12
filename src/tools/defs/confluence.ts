import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Confluence admin tools (spaces, permissions, templates, blueprints,
 * content restrictions). OAuth via confluenceBase.
 */
const V2 = "/wiki/api/v2";
const V1 = "/wiki/rest/api";

export const confluenceAdminTools = (): AnyToolDef[] => [
  defineTool({
    name: "confluence.listConfluenceSpaces",
    description: "List Confluence spaces.",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(250).default(25).optional(),
      type: z.enum(["global", "personal"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
    },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({ limit: String(input.limit ?? 25) });
      if (input.cursor) p.set("cursor", input.cursor);
      if (input.type) p.set("type", input.type);
      if (input.status) p.set("status", input.status);
      const resp = await ctx.client.confluence().get<unknown>(`${V2}/spaces?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.getConfluenceSpace",
    description: "Get a single Confluence space.",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: { spaceId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.confluence().get<unknown>(`${V2}/spaces/${encodeURIComponent(input.spaceId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.createConfluenceSpace",
    description: "Create a Confluence space.",
    group: "write_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      key: z.string().min(1).max(255),
      name: z.string().min(1),
      description: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const body = {
        key: input.key,
        name: input.name,
        description: input.description ? { plain: { value: input.description } } : undefined,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "confluence.createConfluenceSpace",
        target: { kind: "confluence_space", key: input.key, name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "confluence.createConfluenceSpace",
        cloudId: ctx.cloudId,
        target: { kind: "confluence_space", key: input.key, name: input.name },
        before: null,
        request: body as Record<string, unknown>,
        revertible: true,
        revertHint: "DELETE the created space (Confluence v1: rest/api/space/{key}).",
        run: async () => {
          const resp = await ctx.client.confluence().post<{ id: string }>(`${V1}/space`, body);
          return resp.data;
        },
      });
      const created = entry.after as { id?: string };
      if (created?.id) entry.target = { ...entry.target, id: created.id };
      return { ok: true, journal_id: entry.opId, space: created };
    },
  }),
  defineTool({
    name: "confluence.updateConfluenceSpace",
    description: "Update a Confluence space (name, description, homepage).",
    group: "write_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      spaceKey: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.confluence();
      const before = await c.get<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`);
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = { plain: { value: input.description } };
      const after = { ...(before.data as object), ...body };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "confluence.updateConfluenceSpace",
        target: { kind: "confluence_space", id: input.spaceKey },
        before: before.data,
        after,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "confluence.updateConfluenceSpace",
        cloudId: ctx.cloudId,
        target: { kind: "confluence_space", id: input.spaceKey },
        before: before.data,
        request: body,
        revertible: true,
        revertHint: "PUT the captured `before` payload back.",
        run: async () => {
          const resp = await c.put<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`, body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "confluence.deleteConfluenceSpace",
    description: "Delete a Confluence space. **Irreversible.**",
    group: "write_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { spaceKey: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const c = ctx.client.confluence();
      const before = await c.get<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "confluence.deleteConfluenceSpace",
          target: { kind: "confluence_space", id: input.spaceKey },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "confluence.deleteConfluenceSpace",
        cloudId: ctx.cloudId,
        target: { kind: "confluence_space", id: input.spaceKey },
        before: before.data,
        request: { spaceKey: input.spaceKey } as Record<string, unknown>,
        revertible: false,
        run: async () => {
          await c.delete<unknown>(`${V1}/space/${encodeURIComponent(input.spaceKey)}`);
          return { deleted: input.spaceKey };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),

  defineTool({
    name: "confluence.listSpacePermissions",
    description: "List permissions on a Confluence space.",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: { spaceId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.confluence().get<unknown>(`${V2}/spaces/${encodeURIComponent(input.spaceId)}/permissions`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.listTemplates",
    description: "List Confluence templates available globally or in a specific space.",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: { spaceKey: z.string().optional(), startAt: z.number().int().nonnegative().default(0).optional(), maxResults: z.number().int().positive().max(100).default(25).optional() },
    handler: async (input, ctx) => {
      const p = new URLSearchParams({
        start: String(input.startAt ?? 0),
        limit: String(input.maxResults ?? 25),
      });
      if (input.spaceKey) p.set("spaceKey", input.spaceKey);
      const resp = await ctx.client.confluence().get<unknown>(`${V1}/template/page?${p.toString()}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.listBlueprints",
    description: "List Confluence blueprints (built-in page templates).",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: { spaceKey: z.string().optional() },
    handler: async (input, ctx) => {
      const p = new URLSearchParams();
      if (input.spaceKey) p.set("spaceKey", input.spaceKey);
      const resp = await ctx.client.confluence().get<unknown>(`${V1}/template/blueprint${p.toString() ? `?${p.toString()}` : ""}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.getContentRestrictions",
    description: "Get the read/update restrictions on a piece of content.",
    group: "read_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    input: { contentId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.confluence().get<unknown>(`${V1}/content/${encodeURIComponent(input.contentId)}/restriction`);
      return resp.data;
    },
  }),
  defineTool({
    name: "confluence.setContentRestrictions",
    description: "Replace restrictions on a piece of content.",
    group: "write_confluence_admin",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      contentId: z.string().min(1),
      restrictions: z.array(z.record(z.string(), z.unknown())).min(1),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.confluence();
      const before = await c.get<unknown>(`${V1}/content/${encodeURIComponent(input.contentId)}/restriction`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "confluence.setContentRestrictions",
        target: { kind: "content_restrictions", id: input.contentId },
        before: before.data,
        after: { restrictions: input.restrictions },
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "confluence.setContentRestrictions",
        cloudId: ctx.cloudId,
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
  }),
];

reverters.register("confluence.createConfluenceSpace", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const key = (entry.target as { key?: string }).key;
  if (!key) throw new Error("Cannot revert: space key missing.");
  await ctx.client.confluence().delete<unknown>(`/wiki/rest/api/space/${encodeURIComponent(key)}`);
  return { deleted: key };
});

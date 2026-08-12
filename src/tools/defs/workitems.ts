import { z } from "zod";
import type { AtlassianClient } from "../../atlassian/client.js";
import type { JournalEntry } from "../../operations/journal.js";
import type { ToolContext } from "../types.js";
import { ValidationError } from "../../middleware/errorHandler.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineTool } from "./defineTool.js";
import { defineOp, defineOpTool } from "./defineOpTool.js";

/**
 * Jira's current UI calls these work items and work types. The public REST API
 * still uses its compatibility-era `/issue` paths, `issues` response property,
 * and `issueType` fields. This module deliberately keeps that vocabulary at the
 * adapter boundary while exposing only `workitems.*` and `workItemIdOrKey` to MCP
 * callers.
 */

const API = "/rest/api/3";
const COMMENT_MARKER_PROPERTY = "gojira.comment.marker";
const JSM_VISIBILITY_PROPERTY = "sd.public.comment";
const MAX_SEARCH_PAGES = 100;
const MAX_COMMENT_PAGES = 200;

type JsonRecord = Record<string, unknown>;

interface CommentPage {
  comments?: JsonRecord[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

interface EnhancedSearchPage {
  issues?: JsonRecord[];
  nextPageToken?: string;
  isLast?: boolean;
}

const workItemIdOrKey = z.string().min(1).describe("Work item id or key (the REST adapter maps this to issueIdOrKey)");
const commentId = z.string().min(1).describe("Comment id");
const bodyText = z.string().min(1).describe("Plain text comment body; converted to Atlassian Document Format");
const bodyDocument = z
  .record(z.string(), z.unknown())
  .describe("Atlassian Document Format comment body; use exactly one of bodyText or bodyDocument");
const customerVisibility = z
  .enum(["internal", "public"])
  .describe("JSM customer visibility. Internal is the safe default for newly created comments.");
const marker = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "Use letters, numbers, dot, underscore, colon, or hyphen")
  .describe("Stable idempotency marker stored as a Jira comment entity property");

function encode(value: string): string {
  return encodeURIComponent(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function textToAdf(text: string): JsonRecord {
  const blocks = text.split(/\n\n+/);
  return {
    type: "doc",
    version: 1,
    content: blocks.map((block) => {
      const lines = block.split("\n");
      const content: JsonRecord[] = [];
      for (const [index, line] of lines.entries()) {
        if (index > 0) content.push({ type: "hardBreak" });
        if (line.length > 0) content.push({ type: "text", text: line });
      }
      return { type: "paragraph", content };
    }),
  };
}

function resolveBody(input: { bodyText?: string; bodyDocument?: JsonRecord }): JsonRecord {
  if (Boolean(input.bodyText) === Boolean(input.bodyDocument)) {
    throw new ValidationError("Provide exactly one of bodyText or bodyDocument.");
  }
  return input.bodyDocument ?? textToAdf(input.bodyText!);
}

function markerProperty(value: string): JsonRecord {
  return { key: COMMENT_MARKER_PROPERTY, value: { marker: value } };
}

function visibilityProperty(visibility: "internal" | "public"): JsonRecord {
  return { key: JSM_VISIBILITY_PROPERTY, value: { internal: visibility === "internal" } };
}

function propertyKey(property: unknown): string | null {
  return typeof asRecord(property)?.key === "string" ? (asRecord(property)!.key as string) : null;
}

function propertyValue(property: unknown): unknown {
  return asRecord(property)?.value;
}

function commentHasMarker(comment: JsonRecord, expected: string): boolean {
  const properties = Array.isArray(comment.properties) ? comment.properties : [];
  return properties.some((property) => {
    if (propertyKey(property) !== COMMENT_MARKER_PROPERTY) return false;
    const value = asRecord(propertyValue(property));
    return value?.marker === expected;
  });
}

function mergeCommentProperties(
  existing: unknown,
  opts: { marker?: string; visibility?: "internal" | "public" },
): JsonRecord[] {
  const replacements = new Map<string, JsonRecord>();
  if (opts.marker) replacements.set(COMMENT_MARKER_PROPERTY, markerProperty(opts.marker));
  if (opts.visibility) replacements.set(JSM_VISIBILITY_PROPERTY, visibilityProperty(opts.visibility));

  const merged: JsonRecord[] = [];
  for (const raw of Array.isArray(existing) ? existing : []) {
    const current = asRecord(raw);
    const key = propertyKey(current);
    if (!current || (key && replacements.has(key))) continue;
    merged.push(current);
  }
  merged.push(...replacements.values());
  return merged;
}

function restoreCommentBody(comment: unknown): JsonRecord {
  const snapshot = asRecord(comment);
  if (!snapshot?.body) throw new Error("Cannot revert: captured comment body is missing.");
  const body: JsonRecord = { body: snapshot.body };
  if (Array.isArray(snapshot.properties)) body.properties = snapshot.properties;
  if (snapshot.visibility) body.visibility = snapshot.visibility;
  return body;
}

async function listAllComments(client: AtlassianClient, workItem: string): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  let startAt = 0;
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    const p = new URLSearchParams({
      startAt: String(startAt),
      maxResults: "100",
      orderBy: "created",
      expand: "properties",
    });
    const resp = await client.get<CommentPage>(`${API}/issue/${encode(workItem)}/comment?${p.toString()}`);
    const comments = resp.data.comments ?? [];
    out.push(...comments);
    const pageSize = resp.data.maxResults ?? comments.length;
    const next = startAt + pageSize;
    if (comments.length === 0 || (typeof resp.data.total === "number" && next >= resp.data.total)) return out;
    startAt = next;
  }
  throw new ValidationError(
    "Comment history exceeds the safe marker-scan limit; refusing an upsert that cannot prove marker uniqueness.",
    { maxPages: MAX_COMMENT_PAGES },
  );
}

async function getComment(client: AtlassianClient, workItem: string, id: string): Promise<JsonRecord> {
  const resp = await client.get<JsonRecord>(
    `${API}/issue/${encode(workItem)}/comment/${encode(id)}?expand=properties`,
  );
  return resp.data;
}

function commentPath(workItem: string, id?: string): string {
  const base = `${API}/issue/${encode(workItem)}/comment`;
  return id ? `${base}/${encode(id)}` : base;
}

const restoreOrDeleteComment = async (entry: JournalEntry, anyCtx: unknown): Promise<unknown> => {
  const ctx = anyCtx as ToolContext;
  const workItem = (entry.request as { workItemIdOrKey?: string }).workItemIdOrKey;
  const id = (entry.target as { id?: string }).id;
  if (!workItem || !id) throw new Error("Cannot revert: work item or comment id missing from the journal entry.");
  const c = ctx.client.jira();
  if (entry.before === null) {
    await c.delete<unknown>(commentPath(workItem, id));
    return { deleted: id };
  }
  const resp = await c.put<JsonRecord>(commentPath(workItem, id), restoreCommentBody(entry.before));
  return { restored: id, comment: resp.data };
};

const workitemsSearch = defineTool({
  name: "workitems.search",
  description:
    "Search Jira work items with JQL or a saved filter, following enhanced-search page tokens up to a caller-set safety cap.",
  group: "read_workitems",
  authMethod: "oauth",
  needsCloudId: true,
  readOnly: true,
  input: {
    jql: z.string().min(1).optional().describe("JQL query; provide exactly one of jql or filterId"),
    filterId: z.string().min(1).optional().describe("Saved filter id; provide exactly one of filterId or jql"),
    additionalJql: z.string().min(1).optional().describe("Extra JQL ANDed with the saved filter; only valid with filterId"),
    fields: z
      .array(z.string().min(1))
      .default(["summary", "status", "assignee", "issuetype", "project"])
      .optional(),
    expand: z.array(z.string().min(1)).optional(),
    pageSize: z.number().int().positive().max(100).default(100).optional(),
    maxItems: z.number().int().positive().max(1000).default(200).optional(),
  },
  handler: async (input, ctx) => {
    if (Boolean(input.jql) === Boolean(input.filterId)) {
      throw new ValidationError("Provide exactly one of jql or filterId.");
    }
    if (input.additionalJql && !input.filterId) {
      throw new ValidationError("additionalJql is only valid with filterId.");
    }

    const c = ctx.client.jira();
    let effectiveJql = input.jql!;
    if (input.filterId) {
      const filter = await c.get<{ jql?: string }>(`${API}/filter/${encode(input.filterId)}`);
      if (!filter.data.jql) throw new ValidationError("Saved filter did not contain JQL.", { filterId: input.filterId });
      effectiveJql = input.additionalJql
        ? `(${filter.data.jql}) AND (${input.additionalJql})`
        : filter.data.jql;
    }

    const maxItems = input.maxItems ?? 200;
    const requestedPageSize = input.pageSize ?? 100;
    const workItems: JsonRecord[] = [];
    let nextPageToken: string | undefined;
    let upstreamHasMore = false;

    for (let page = 0; page < MAX_SEARCH_PAGES && workItems.length < maxItems; page++) {
      const remaining = maxItems - workItems.length;
      const body: JsonRecord = {
        jql: effectiveJql,
        maxResults: Math.min(requestedPageSize, remaining),
        fields: input.fields ?? ["summary", "status", "assignee", "issuetype", "project"],
      };
      if (input.expand?.length) body.expand = input.expand.join(",");
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const resp = await c.post<EnhancedSearchPage>(`${API}/search/jql`, body);
      const pageItems = resp.data.issues ?? [];
      workItems.push(...pageItems.slice(0, remaining));
      nextPageToken = resp.data.nextPageToken;
      upstreamHasMore = Boolean(nextPageToken) || resp.data.isLast === false;
      if (!nextPageToken || resp.data.isLast === true || pageItems.length === 0) break;
    }

    return {
      workItems,
      count: workItems.length,
      truncated: upstreamHasMore,
      nextPageToken: nextPageToken ?? null,
      effectiveJql,
      source: input.filterId ? { type: "saved_filter", filterId: input.filterId } : { type: "jql" },
      adapter: { responseCollection: "issues", restResource: "/rest/api/3/search/jql" },
    };
  },
});

const workitemsRead = defineOpTool({
  name: "workitems.read",
  description: "Read a Jira work item (getWorkItem) or its comments (listComments).",
  group: "read_workitems",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "getWorkItem",
      description: "Get one work item by id or key.",
      input: {
        workItemIdOrKey,
        fields: z.array(z.string().min(1)).optional(),
        expand: z.array(z.string().min(1)).optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams();
        if (input.fields?.length) p.set("fields", input.fields.join(","));
        if (input.expand?.length) p.set("expand", input.expand.join(","));
        const suffix = p.toString() ? `?${p.toString()}` : "";
        const resp = await ctx.client.jira().get<JsonRecord>(`${API}/issue/${encode(input.workItemIdOrKey)}${suffix}`);
        return { workItem: resp.data, adapter: { restResource: "/rest/api/3/issue/{issueIdOrKey}" } };
      },
    }),
    defineOp({
      op: "listComments",
      description: "List comments on one work item, including entity properties when permitted.",
      input: {
        workItemIdOrKey,
        startAt: z.number().int().nonnegative().default(0).optional(),
        maxResults: z.number().int().positive().max(100).default(50).optional(),
        orderBy: z.enum(["created", "-created", "+created"]).default("created").optional(),
      },
      handler: async (input, ctx) => {
        const p = new URLSearchParams({
          startAt: String(input.startAt ?? 0),
          maxResults: String(input.maxResults ?? 50),
          orderBy: input.orderBy ?? "created",
          expand: "properties",
        });
        const resp = await ctx.client
          .jira()
          .get<CommentPage>(`${API}/issue/${encode(input.workItemIdOrKey)}/comment?${p.toString()}`);
        return resp.data;
      },
    }),
  ],
});

const workitemsManageComment = defineOpTool({
  name: "workitems.manageComment",
  description:
    "Manage work-item comments: create one, update one, or idempotently upsert one by a stable entity-property marker. All operations are dry-run-first and revertible.",
  group: "write_workitems",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createComment",
      description: "Create a comment. JSM visibility defaults to internal. Revert deletes the created comment.",
      destructive: true,
      input: {
        workItemIdOrKey,
        bodyText: bodyText.optional(),
        bodyDocument: bodyDocument.optional(),
        visibility: customerVisibility.default("internal").optional(),
      },
      revert: restoreOrDeleteComment,
      handler: async (input, ctx, meta) => {
        const payload = {
          body: resolveBody(input),
          properties: [visibilityProperty(input.visibility ?? "internal")],
        };
        const dry = meta.dryRun({
          target: { kind: "work_item_comment", parent: input.workItemIdOrKey },
          before: null,
          after: payload,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "work_item_comment", parent: input.workItemIdOrKey },
          before: null,
          request: { workItemIdOrKey: input.workItemIdOrKey, visibility: input.visibility ?? "internal" },
          revertible: true,
          revertHint: "Delete the created comment.",
          deriveTargetId: (after) => String((after as { id?: unknown }).id ?? "") || undefined,
          run: async () => (await ctx.client.jira().post<JsonRecord>(commentPath(input.workItemIdOrKey), payload)).data,
        });
        return { ok: true, journal_id: entry.opId, comment: entry.after };
      },
    }),
    defineOp({
      op: "updateComment",
      description: "Update a comment body and optionally its JSM visibility. Revert restores the captured comment.",
      destructive: true,
      input: {
        workItemIdOrKey,
        commentId,
        bodyText: bodyText.optional(),
        bodyDocument: bodyDocument.optional(),
        visibility: customerVisibility.optional(),
      },
      revert: restoreOrDeleteComment,
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const before = await getComment(c, input.workItemIdOrKey, input.commentId);
        const payload: JsonRecord = { body: resolveBody(input) };
        if (input.visibility) {
          payload.properties = mergeCommentProperties(before.properties, { visibility: input.visibility });
        }
        const dry = meta.dryRun({
          target: { kind: "work_item_comment", id: input.commentId, parent: input.workItemIdOrKey },
          before,
          after: payload,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "work_item_comment", id: input.commentId, parent: input.workItemIdOrKey },
          before,
          request: { workItemIdOrKey: input.workItemIdOrKey, commentId: input.commentId },
          revertible: true,
          revertHint: "Restore the captured comment body, properties, and Jira visibility restriction.",
          run: async () => (await c.put<JsonRecord>(commentPath(input.workItemIdOrKey, input.commentId), payload)).data,
        });
        return { ok: true, journal_id: entry.opId, comment: entry.after };
      },
    }),
    defineOp({
      op: "upsertComment",
      description:
        "Create or update exactly one comment selected by a stable marker. Fails closed if duplicate markers exist; revert restores or deletes as appropriate.",
      destructive: true,
      input: {
        workItemIdOrKey,
        marker,
        bodyText: bodyText.optional(),
        bodyDocument: bodyDocument.optional(),
        visibility: customerVisibility.optional(),
      },
      revert: restoreOrDeleteComment,
      handler: async (input, ctx, meta) => {
        const c = ctx.client.jira();
        const matches = (await listAllComments(c, input.workItemIdOrKey)).filter((comment) =>
          commentHasMarker(comment, input.marker),
        );
        if (matches.length > 1) {
          throw new ValidationError("Multiple comments carry this marker; refusing an ambiguous upsert.", {
            marker: input.marker,
            commentIds: matches.map((comment) => comment.id),
          });
        }
        const before = matches[0] ?? null;
        const id = before?.id === undefined ? undefined : String(before.id);
        const visibility = input.visibility ?? (id ? undefined : "internal");
        const payload = {
          body: resolveBody(input),
          properties: mergeCommentProperties(before?.properties, {
            marker: input.marker,
            visibility,
          }),
        };
        const dry = meta.dryRun({
          target: { kind: "work_item_comment", ...(id ? { id } : {}), parent: input.workItemIdOrKey, marker: input.marker },
          before,
          after: payload,
          message: id ? "Update the uniquely marked comment." : "Create a newly marked comment.",
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
          target: { kind: "work_item_comment", ...(id ? { id } : {}), parent: input.workItemIdOrKey, marker: input.marker },
          before,
          request: { workItemIdOrKey: input.workItemIdOrKey, marker: input.marker },
          revertible: true,
          revertHint: id ? "Restore the captured uniquely marked comment." : "Delete the created uniquely marked comment.",
          deriveTargetId: (after) => String((after as { id?: unknown }).id ?? "") || undefined,
          run: async () => {
            if (id) return (await c.put<JsonRecord>(commentPath(input.workItemIdOrKey, id), payload)).data;
            return (await c.post<JsonRecord>(commentPath(input.workItemIdOrKey), payload)).data;
          },
        });
        return { ok: true, journal_id: entry.opId, action: id ? "updated" : "created", comment: entry.after };
      },
    }),
  ],
});

export const workitemTools = (): AnyToolDef[] => [workitemsSearch, workitemsRead, workitemsManageComment];

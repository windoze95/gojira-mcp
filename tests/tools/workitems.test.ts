import { describe, expect, it, vi } from "vitest";
import { allTools } from "../../src/tools/defs/index.js";
import type { ToolContext } from "../../src/tools/types.js";

type Method = ReturnType<typeof vi.fn>;

function response(data: unknown) {
  return { data, status: 200, meta: { nearLimit: false, rateLimitResetUnix: null, rateLimitRemaining: null } };
}

function tool(name: string) {
  const found = allTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function ctxWith(client: { get?: Method; post?: Method; put?: Method; delete?: Method }): ToolContext {
  const jira = {
    get: client.get ?? vi.fn(),
    post: client.post ?? vi.fn(),
    put: client.put ?? vi.fn(),
    delete: client.delete ?? vi.fn(),
  };
  return {
    accountId: "acct",
    cloudId: "cloud",
    client: { jira: () => jira },
    defaultJournalArgs: { accountId: "acct", cloudId: "cloud", tool: "workitems.manageComment" },
    journalOp: vi.fn(async (args) => {
      const after = await args.run();
      return {
        opId: "journal-1",
        accountId: "acct",
        tool: args.tool,
        cloudId: "cloud",
        target: args.target,
        before: args.before,
        after,
        request: args.request,
        requestedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
        outcome: "success",
        revertible: args.revertible,
      };
    }),
  } as unknown as ToolContext;
}

describe("workitems.search", () => {
  it("resolves a saved filter and follows enhanced-search page tokens", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/rest/api/3/filter/42");
      return response({ jql: "project = SYN" });
    });
    const post = vi
      .fn()
      .mockResolvedValueOnce(response({ issues: [{ key: "SYN-1" }], nextPageToken: "next", isLast: false }))
      .mockResolvedValueOnce(response({ issues: [{ key: "SYN-2" }], isLast: true }));

    const result = (await tool("workitems.search").handler(
      { filterId: "42", additionalJql: "statusCategory != Done", pageSize: 1, maxItems: 10 },
      ctxWith({ get, post }),
    )) as Record<string, unknown>;

    expect(result.effectiveJql).toBe("(project = SYN) AND (statusCategory != Done)");
    expect(result.workItems).toEqual([{ key: "SYN-1" }, { key: "SYN-2" }]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toMatchObject({ nextPageToken: "next", maxResults: 1 });
  });

  it("rejects ambiguous or invalid search sources", async () => {
    const ctx = ctxWith({});
    await expect(tool("workitems.search").handler({ jql: "x", filterId: "1" }, ctx)).rejects.toThrow(
      /exactly one/,
    );
    await expect(tool("workitems.search").handler({ jql: "x", additionalJql: "y" }, ctx)).rejects.toThrow(
      /only valid with filterId/,
    );
  });
});

describe("workitems.manageComment", () => {
  it("keeps create dry-run-first and defaults JSM visibility to internal", async () => {
    const post = vi.fn();
    const ctx = ctxWith({ post });
    const result = (await tool("workitems.manageComment").handler(
      { op: "createComment", workItemIdOrKey: "SYN-1", bodyText: "Development links" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.dry_run).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(ctx.journalOp).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('"internal":true');
  });

  it("creates a uniquely marked comment through the journal on commit", async () => {
    const get = vi.fn(async () => response({ comments: [], startAt: 0, maxResults: 100, total: 0 }));
    const post = vi.fn(async (_path: string, body: unknown) => response({ id: "9001", ...(body as object) }));
    const ctx = ctxWith({ get, post });

    const result = (await tool("workitems.manageComment").handler(
      {
        op: "upsertComment",
        workItemIdOrKey: "SYN-1",
        marker: "dev-links",
        bodyText: "Form: https://example.invalid/form",
        commit: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ ok: true, action: "created", journal_id: "journal-1" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(post.mock.calls[0][1])).toContain("gojira.comment.marker");
    expect(JSON.stringify(post.mock.calls[0][1])).toContain("dev-links");
    expect(ctx.journalOp).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing marked comment's public visibility unless explicitly changed", async () => {
    const existing = {
      id: "9002",
      body: { type: "doc", version: 1, content: [] },
      properties: [
        { key: "gojira.comment.marker", value: { marker: "dev-links" } },
        { key: "sd.public.comment", value: { internal: false } },
      ],
    };
    const get = vi.fn(async () => response({ comments: [existing], startAt: 0, maxResults: 100, total: 1 }));
    const put = vi.fn(async (_path: string, body: unknown) => response({ id: "9002", ...(body as object) }));

    const result = (await tool("workitems.manageComment").handler(
      {
        op: "upsertComment",
        workItemIdOrKey: "SYN-1",
        marker: "dev-links",
        bodyText: "Updated development links",
        commit: true,
      },
      ctxWith({ get, put }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({ action: "updated" });
    expect(JSON.stringify(put.mock.calls[0][1])).toContain('"internal":false');
  });

  it("fails closed when the marker is duplicated", async () => {
    const marked = {
      properties: [{ key: "gojira.comment.marker", value: { marker: "dev-links" } }],
    };
    const get = vi.fn(async () =>
      response({ comments: [{ id: "1", ...marked }, { id: "2", ...marked }], startAt: 0, maxResults: 100, total: 2 }),
    );
    await expect(
      tool("workitems.manageComment").handler(
        { op: "upsertComment", workItemIdOrKey: "SYN-1", marker: "dev-links", bodyText: "x" },
        ctxWith({ get }),
      ),
    ).rejects.toThrow(/Multiple comments carry this marker/);
  });
});

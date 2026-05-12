import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted } from "../../consent/dryRun.js";
import { validateProjectKey } from "../../utils/validators.js";
import { reverters } from "../../operations/revert.js";

/**
 * Project admin tools (OAuth) — list/get/create/archive.
 * Delete lives in its own isolated permission group; see deleteProjects.ts.
 */
export const projectTools = (): AnyToolDef[] => [
  defineTool({
    name: "projects.listJiraProjects",
    description: "List Jira projects (admin view). Returns paged results with project metadata.",
    group: "read_projects",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      startAt: z.number().int().nonnegative().default(0).optional(),
      maxResults: z.number().int().positive().max(100).default(50).optional(),
      expand: z.array(z.enum(["description", "lead", "issueTypes", "url", "projectKeys", "permissions", "insight"])).optional(),
      query: z.string().optional().describe("Substring match against name or key."),
      typeKey: z.string().optional(),
      orderBy: z
        .enum(["name", "category", "issueCount", "lastIssueUpdatedTime"])
        .default("name")
        .optional(),
    },
    handler: async (input, ctx) => {
      const params = new URLSearchParams();
      params.set("startAt", String(input.startAt ?? 0));
      params.set("maxResults", String(input.maxResults ?? 50));
      if (input.expand?.length) params.set("expand", input.expand.join(","));
      if (input.query) params.set("query", input.query);
      if (input.typeKey) params.set("typeKey", input.typeKey);
      if (input.orderBy) params.set("orderBy", input.orderBy);
      const resp = await ctx.client.jira().get<unknown>(`/rest/api/3/project/search?${params.toString()}`);
      return resp.data;
    },
  }),

  defineTool({
    name: "projects.getJiraProject",
    description: "Retrieve a single Jira project by key or numeric id.",
    group: "read_projects",
    authMethod: "oauth",
    needsCloudId: true,
    input: {
      project: z.string().min(1).describe("Project key or id."),
      expand: z.array(z.string()).optional(),
    },
    handler: async (input, ctx) => {
      const expand = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
      const resp = await ctx.client.jira().get<unknown>(
        `/rest/api/3/project/${encodeURIComponent(input.project)}${expand}`,
      );
      return resp.data;
    },
  }),

  defineTool({
    name: "projects.getJiraProjectDetails",
    description: "Retrieve a Jira project plus its components, roles, and notification scheme assignments.",
    group: "read_projects",
    authMethod: "oauth",
    needsCloudId: true,
    input: { project: z.string().min(1) },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const [proj, components, roles] = await Promise.all([
        c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}?expand=description,lead,issueTypes,projectKeys,permissions,insight`),
        c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}/components`),
        c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}/role`),
      ]);
      return { project: proj.data, components: components.data, roles: roles.data };
    },
  }),

  defineTool({
    name: "projects.createJiraProject",
    description:
      "Create a Jira project. Destructive — call without `commit:true` first to see the proposed body.",
    group: "write_projects",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      key: z
        .string()
        .min(2)
        .max(10)
        .describe("Project key (uppercase letters and digits, must start with a letter)."),
      name: z.string().min(1),
      projectTypeKey: z.enum(["software", "service_desk", "business"]),
      projectTemplateKey: z.string().optional(),
      leadAccountId: z.string(),
      description: z.string().optional(),
      assigneeType: z.enum(["PROJECT_LEAD", "UNASSIGNED"]).optional(),
      url: z.string().url().optional(),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      validateProjectKey(input.key);
      const body = {
        key: input.key,
        name: input.name,
        projectTypeKey: input.projectTypeKey,
        projectTemplateKey: input.projectTemplateKey,
        leadAccountId: input.leadAccountId,
        description: input.description,
        assigneeType: input.assigneeType ?? "PROJECT_LEAD",
        url: input.url,
      };
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "projects.createJiraProject",
        target: { kind: "jira_project", key: input.key, name: input.name },
        before: null,
        after: body,
      });
      if (dry) return dry;

      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "projects.createJiraProject",
        cloudId: ctx.cloudId,
        target: { kind: "jira_project", key: input.key, name: input.name },
        before: null,
        request: { ...body } as Record<string, unknown>,
        revertible: false, // Project archive ≠ revert; project delete is its own gated op.
        revertHint: "Project creation is not auto-revertible; archive or delete manually if needed.",
        run: async () => {
          const resp = await ctx.client.jira().post<unknown>("/rest/api/3/project", body);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, project: entry.after };
    },
  }),

  defineTool({
    name: "projects.archiveJiraProject",
    description: "Archive a Jira project. Requires `commit:true` to apply.",
    group: "write_projects",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: { project: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const before = await ctx.client
        .jira()
        .get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}`);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "projects.archiveJiraProject",
        target: { kind: "jira_project", id: input.project },
        before: before.data,
        after: { archived: true },
      });
      if (dry) return dry;

      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "projects.archiveJiraProject",
        cloudId: ctx.cloudId,
        target: { kind: "jira_project", id: input.project },
        before: before.data,
        request: { project: input.project } as Record<string, unknown>,
        revertible: true,
        revertHint: "Restore the project via /rest/api/3/project/{key}/restore.",
        run: async () => {
          await ctx.client.jira().post<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}/archive`);
          return { archived: true, project: input.project };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
];

// Reverter for archive: POST /rest/api/3/project/{key}/restore
reverters.register("projects.archiveJiraProject", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: original target.id missing.");
  const resp = await ctx.client.jira().post<unknown>(`/rest/api/3/project/${encodeURIComponent(id)}/restore`);
  return { restored: true, response: resp.data };
});

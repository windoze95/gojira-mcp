import { z } from "zod";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { validateProjectKey } from "../../utils/validators.js";
import { ValidationError } from "../../middleware/errorHandler.js";
import type { ToolContext } from "../types.js";

/**
 * Project admin tools (OAuth) — read/create/archive.
 * Delete lives in its own isolated permission group; see deleteProjects.ts.
 */

// Hoisted shared field schemas.
const projectKeyOrId = z.string().min(1).describe("Project key or numeric id");
// listJiraProjects accepts a fixed expand vocabulary; getJiraProject passes
// expand through verbatim — unified as string[] with the list op validating
// its vocabulary in the handler.
const projectExpand = z.array(z.string()).describe("Expand parameters");

const LIST_EXPAND_VALUES = new Set([
  "description",
  "lead",
  "issueTypes",
  "url",
  "projectKeys",
  "permissions",
  "insight",
]);

const projectsRead = defineOpTool({
  name: "projects.read",
  description:
    "Read Jira projects: paged admin list/search (listJiraProjects), get one project (getJiraProject), or get a project plus components and roles in one call (getJiraProjectDetails).",
  group: "read_projects",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listJiraProjects",
      description:
        "List Jira projects (admin view, paginated). expand values: description, lead, issueTypes, url, projectKeys, permissions, insight.",
      legacyName: "projects.listJiraProjects",
      input: {
        startAt: z.number().int().nonnegative().default(0).optional().describe("Page offset"),
        maxResults: z.number().int().positive().max(100).default(50).optional().describe("Page size"),
        expand: projectExpand.optional(),
        query: z.string().optional().describe("Substring match against name or key."),
        typeKey: z.string().optional(),
        orderBy: z.enum(["name", "category", "issueCount", "lastIssueUpdatedTime"]).default("name").optional(),
      },
      handler: async (input, ctx) => {
        // The unified expand schema is free-form; this op's endpoint accepts a
        // fixed vocabulary — reject typos rather than silently dropping them.
        const invalid = (input.expand ?? []).filter((e) => !LIST_EXPAND_VALUES.has(e));
        if (invalid.length > 0) {
          throw new ValidationError("Invalid expand values for listJiraProjects.", {
            invalid,
            valid: [...LIST_EXPAND_VALUES],
          });
        }
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
    defineOp({
      op: "getJiraProject",
      description: "Retrieve a single Jira project by key or numeric id.",
      legacyName: "projects.getJiraProject",
      input: { project: projectKeyOrId, expand: projectExpand.optional() },
      handler: async (input, ctx) => {
        const expand = input.expand?.length ? `?expand=${encodeURIComponent(input.expand.join(","))}` : "";
        const resp = await ctx.client
          .jira()
          .get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}${expand}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getJiraProjectDetails",
      description: "Retrieve a Jira project plus its components, roles, and notification scheme assignments.",
      legacyName: "projects.getJiraProjectDetails",
      input: { project: projectKeyOrId },
      handler: async (input, ctx) => {
        const c = ctx.client.jira();
        const [proj, components, roles] = await Promise.all([
          c.get<unknown>(
            `/rest/api/3/project/${encodeURIComponent(input.project)}?expand=description,lead,issueTypes,projectKeys,permissions,insight`,
          ),
          c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}/components`),
          c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}/role`),
        ]);
        return { project: proj.data, components: components.data, roles: roles.data };
      },
    }),
  ],
});

const projectsManage = defineOpTool({
  name: "projects.manage",
  description:
    "Create a Jira project (createJiraProject) or archive one (archiveJiraProject — revertible via restore). Deletion is a separate opt-in tool (projects.delete).",
  group: "write_projects",
  authMethod: "oauth",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createJiraProject",
      description: "Create a Jira project. Not auto-revertible; archive or delete manually if needed.",
      destructive: true,
      legacyName: "projects.createJiraProject",
      input: {
        key: z
          .string()
          .min(2)
          .max(10)
          .describe("Project key (uppercase letters and digits, must start with a letter)."),
        name: z.string().min(1).describe("Project name"),
        projectTypeKey: z.enum(["software", "service_desk", "business"]),
        projectTemplateKey: z.string().optional(),
        leadAccountId: z.string().describe("Atlassian accountId of the project lead"),
        description: z.string().optional(),
        assigneeType: z.enum(["PROJECT_LEAD", "UNASSIGNED"]).optional(),
        url: z.string().url().optional(),
      },
      handler: async (input, ctx, meta) => {
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
        const dry = meta.dryRun({
          target: { kind: "jira_project", key: input.key, name: input.name },
          before: null,
          after: body,
        });
        if (dry) return dry;

        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
    defineOp({
      op: "archiveJiraProject",
      description: "Archive a Jira project. Revertible via restore.",
      destructive: true,
      legacyName: "projects.archiveJiraProject",
      input: { project: projectKeyOrId },
      handler: async (input, ctx, meta) => {
        const before = await ctx.client
          .jira()
          .get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}`);
        const dry = meta.dryRun({
          target: { kind: "jira_project", id: input.project },
          before: before.data,
          after: { archived: true },
        });
        if (dry) return dry;

        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverter for archive: POST /rest/api/3/project/{key}/restore
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        if (!id) throw new Error("Cannot revert: original target.id missing.");
        const resp = await ctx.client.jira().post<unknown>(`/rest/api/3/project/${encodeURIComponent(id)}/restore`);
        return { restored: true, response: resp.data };
      },
    }),
  ],
});

export const projectTools = (): AnyToolDef[] => [projectsRead, projectsManage];

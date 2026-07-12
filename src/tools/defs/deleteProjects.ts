import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDeleteDryRun } from "../../consent/dryRun.js";

/**
 * Isolated permission group `delete_projects` — separate from
 * `write_projects` so disabling deletion doesn't disable archive/restore.
 */
export const deleteProjectTools = (): AnyToolDef[] => [
  defineTool({
    name: "projects.deleteJiraProject",
    description:
      "Delete a Jira project. Defaults to move-to-trash (recoverable for ~60 days); pass `permanent: true` " +
      "to hard-delete with no undo. **Re-invoke with `commit: true` after reviewing the dry-run.**",
    group: "delete_projects",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      project: z.string().min(1).describe("Project key or numeric id."),
      permanent: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "false (default) = move to trash, restorable for ~60 days. true = permanent hard-delete, NO undo.",
        ),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      // enableUndo defaults to TRUE on the DELETE endpoint, so we ALWAYS send it
      // explicitly to match the caller's intent. permanent=true => enableUndo=false.
      const permanent = input.permanent === true;
      const enableUndo = !permanent;
      const before = await c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "projects.deleteJiraProject",
          target: { kind: "jira_project", id: input.project },
          before: before.data,
          message: permanent
            ? "Would PERMANENTLY DELETE the project. Re-invoke with commit:true to apply. NO UNDO."
            : "Would move the project to TRASH (restorable for ~60 days). Re-invoke with commit:true to apply.",
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "projects.deleteJiraProject",
        cloudId: ctx.cloudId,
        target: { kind: "jira_project", id: input.project },
        before: before.data,
        request: { project: input.project, permanent } as Record<string, unknown>,
        revertible: enableUndo,
        revertHint: enableUndo
          ? "POST /rest/api/3/project/{key}/restore within the ~60-day trash window."
          : "Permanent deletion has no programmatic undo. Restore from backup if available.",
        run: async () => {
          const path = `/rest/api/3/project/${encodeURIComponent(input.project)}?enableUndo=${enableUndo}`;
          await c.delete<unknown>(path);
          return { deleted: input.project, permanent, restorable: enableUndo };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
];

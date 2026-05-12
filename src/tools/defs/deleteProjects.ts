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
      "Permanently delete a Jira project. **Irreversible.** Re-invoke with `commit: true` after reviewing the dry-run.",
    group: "delete_projects",
    authMethod: "oauth",
    needsCloudId: true,
    destructive: true,
    input: {
      project: z.string().min(1).describe("Project key or numeric id."),
      enableUndo: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "If true, uses the move-to-trash endpoint (recoverable for 60 days). Default false = permanent delete.",
        ),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const c = ctx.client.jira();
      const before = await c.get<unknown>(`/rest/api/3/project/${encodeURIComponent(input.project)}`);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "projects.deleteJiraProject",
          target: { kind: "jira_project", id: input.project },
          before: before.data,
          message: input.enableUndo
            ? "Would TRASH the project (60-day undo window). Re-invoke with commit:true to apply."
            : "Would PERMANENTLY DELETE the project. Re-invoke with commit:true to apply. NO UNDO.",
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "projects.deleteJiraProject",
        cloudId: ctx.cloudId,
        target: { kind: "jira_project", id: input.project },
        before: before.data,
        request: { project: input.project, enableUndo: input.enableUndo } as Record<string, unknown>,
        revertible: input.enableUndo ?? false,
        revertHint: input.enableUndo
          ? "POST /rest/api/3/project/{key}/restore within the 60-day window."
          : "Permanent deletion has no programmatic undo. Restore from backup if available.",
        run: async () => {
          const path = `/rest/api/3/project/${encodeURIComponent(input.project)}${input.enableUndo ? "?enableUndo=true" : ""}`;
          await c.delete<unknown>(path);
          return { deleted: input.project, undo: input.enableUndo === true };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
];

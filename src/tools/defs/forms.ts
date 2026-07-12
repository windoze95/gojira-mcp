import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun } from "../../consent/dryRun.js";
import { reverters } from "../../operations/revert.js";

/**
 * Jira Forms (ProForma) — portal request forms, IT-support intake forms, and
 * forms attached to issues/requests, via the Forms REST API's Basic-auth host:
 *   https://api.atlassian.com/jira/forms/cloud/{cloudId}/...
 * (ctx.client.forms()).
 *
 * AUTH (verified live): the per-user API token via Basic auth — the same
 * `api_token` side-channel the JSM admin and automation tools use. No extra
 * OAuth scope is needed for this host. Full template lifecycle exercised
 * against a live tenant: create 200 {id} → list → get (design export) →
 * update 200 → delete 200 → 404.
 *
 * The form `design` schema is the ProForma design document
 * ({settings, questions, sections, conditions, layout}); the practical
 * authoring path is: create a form in the UI or from a minimal design, export
 * it with getFormTemplate, and adapt.
 */
const BASE = "";

const projectPath = (projectIdOrKey: string): string => `${BASE}/project/${encodeURIComponent(projectIdOrKey)}/form`;

export const formsTools = (): AnyToolDef[] => [
  defineTool({
    name: "forms.listFormTemplates",
    description: "List the form templates of a project (portal request forms / intake forms live here).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { projectIdOrKey: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.forms().get<unknown>(projectPath(input.projectIdOrKey));
      return resp.data;
    },
  }),
  defineTool({
    name: "forms.getFormTemplate",
    description: "Get a project form template by id, including its full `design` document (use this to export/adapt).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { projectIdOrKey: z.string().min(1), formId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .forms()
        .get<unknown>(`${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`);
      return resp.data;
    },
  }),
  defineTool({
    name: "forms.getRequestTypeForm",
    description: "Get the portal form attached to a JSM request type (404 if the request type has no form).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { serviceDeskId: z.string().min(1), requestTypeId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .forms()
        .get<unknown>(
          `${BASE}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/form`,
        );
      return resp.data;
    },
  }),
  defineTool({
    name: "forms.listIssueForms",
    description: "List the forms attached to an issue/request (agent view).",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { issueIdOrKey: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client.forms().get<unknown>(`${BASE}/issue/${encodeURIComponent(input.issueIdOrKey)}/form`);
      return resp.data;
    },
  }),
  defineTool({
    name: "forms.getIssueFormAnswers",
    description: "Get a submitted issue form's answers in simplified format.",
    group: "read_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    input: { issueIdOrKey: z.string().min(1), formId: z.string().min(1) },
    handler: async (input, ctx) => {
      const resp = await ctx.client
        .forms()
        .get<unknown>(
          `${BASE}/issue/${encodeURIComponent(input.issueIdOrKey)}/form/${encodeURIComponent(input.formId)}/format/answers`,
        );
      return resp.data;
    },
  }),

  defineTool({
    name: "forms.createFormTemplate",
    description:
      "Create a form template on a project. `form` must contain a `design` document " +
      "({settings, questions, sections, conditions, layout}) — export an existing template with " +
      "forms.getFormTemplate for the shape. Destructive — requires `commit:true`.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      projectIdOrKey: z.string().min(1),
      form: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "forms.createFormTemplate",
        target: { kind: "form_template", name: (input.form as { name?: string }).name ?? "(unnamed)" },
        before: null,
        after: input.form,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "forms.createFormTemplate",
        cloudId: ctx.cloudId,
        target: { kind: "form_template", name: (input.form as { name?: string }).name ?? "(unnamed)" },
        before: null,
        request: { projectIdOrKey: input.projectIdOrKey, form: input.form },
        revertible: true,
        revertHint: "DELETE the form template by its id.",
        deriveTargetId: (after) => (after as { id?: string })?.id,
        run: async () => {
          const resp = await ctx.client.forms().post<{ id?: string }>(projectPath(input.projectIdOrKey), input.form);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId, form: entry.after };
    },
  }),
  defineTool({
    name: "forms.updateFormTemplate",
    description:
      "Replace a form template in place (rename, edit the design, attach to portal request types via " +
      "`portalRequestTypeIds`). Captures full before/after.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: {
      projectIdOrKey: z.string().min(1),
      formId: z.string().min(1),
      form: z.record(z.string(), z.unknown()),
      commit: z.boolean().optional(),
    },
    handler: async (input, ctx) => {
      const path = `${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`;
      const before = await ctx.client.forms().get<unknown>(path);
      const dry = buildDryRunIfNotCommitted(input, {
        tool: "forms.updateFormTemplate",
        target: { kind: "form_template", id: input.formId },
        before: before.data,
        after: input.form,
      });
      if (dry) return dry;
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "forms.updateFormTemplate",
        cloudId: ctx.cloudId,
        target: { kind: "form_template", id: input.formId },
        before: before.data,
        request: { projectIdOrKey: input.projectIdOrKey, formId: input.formId, form: input.form },
        revertible: true,
        revertHint: "PUT the captured `before` template back to the same id.",
        run: async () => {
          const resp = await ctx.client.forms().put<unknown>(path, input.form);
          return resp.data;
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
  defineTool({
    name: "forms.deleteFormTemplate",
    description:
      "Delete a project form template. **Irreversible** — the full template (design included) is captured in the " +
      "journal `before` for manual re-creation.",
    group: "write_jsm_admin",
    authMethod: "api_token",
    needsCloudId: true,
    destructive: true,
    input: { projectIdOrKey: z.string().min(1), formId: z.string().min(1), commit: z.boolean().optional() },
    handler: async (input, ctx) => {
      const path = `${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`;
      const before = await ctx.client.forms().get<unknown>(path);
      if (input.commit !== true) {
        return buildDeleteDryRun({
          tool: "forms.deleteFormTemplate",
          target: { kind: "form_template", id: input.formId },
          before: before.data,
        });
      }
      const entry = await ctx.journalOp({
        accountId: ctx.accountId,
        tool: "forms.deleteFormTemplate",
        cloudId: ctx.cloudId,
        target: { kind: "form_template", id: input.formId },
        before: before.data,
        request: { projectIdOrKey: input.projectIdOrKey, formId: input.formId },
        revertible: false,
        run: async () => {
          await ctx.client.forms().delete<unknown>(path);
          return { deleted: input.formId };
        },
      });
      return { ok: true, journal_id: entry.opId };
    },
  }),
];

// Reverting a template create = delete it. The project path is required by the
// API, so it is journaled in `request`.
reverters.register("forms.createFormTemplate", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  const project = (entry.request as { projectIdOrKey?: string } | null)?.projectIdOrKey;
  if (!id || !project) throw new Error("Cannot revert: created form id or project missing from the journal entry.");
  await ctx.client.forms().delete<unknown>(`/project/${encodeURIComponent(project)}/form/${encodeURIComponent(id)}`);
  return { deleted: id };
});

// Reverting an update = PUT the captured before back.
reverters.register("forms.updateFormTemplate", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const id = (entry.target as { id?: string }).id;
  const project = (entry.request as { projectIdOrKey?: string } | null)?.projectIdOrKey;
  if (!id || !project) throw new Error("Cannot revert: form id or project missing from the journal entry.");
  if (!entry.before) throw new Error("Cannot revert: journal entry has no captured `before` template.");
  const resp = await ctx.client
    .forms()
    .put<unknown>(`/project/${encodeURIComponent(project)}/form/${encodeURIComponent(id)}`, entry.before);
  return { reverted: id, response: resp.data };
});

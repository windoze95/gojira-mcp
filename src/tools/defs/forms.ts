import { z } from "zod";
import { defineTool } from "./defineTool.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineOpTool, defineOp } from "./defineOpTool.js";
import { buildDeleteDryRun } from "../../consent/dryRun.js";
import type { ToolContext } from "../types.js";

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
 * it with forms.read getFormTemplate, and adapt.
 */
const BASE = "";

const projectPath = (projectIdOrKey: string): string => `${BASE}/project/${encodeURIComponent(projectIdOrKey)}/form`;

// Hoisted shared field schemas. Two distinct id spaces exist deliberately:
// project template ids vs issue-form ids — disambiguated per op.
const projectIdOrKey = z.string().min(1).describe("Project id or key");
const formId = z.string().min(1).describe("Form id (project TEMPLATE id or ISSUE form id, per op)");
const serviceDeskId = z.string().min(1).describe("Service desk id");
const requestTypeId = z.string().min(1).describe("Request type id");
const issueIdOrKey = z.string().min(1).describe("Issue/request id or key");
const formDocument = z
  .record(z.string(), z.unknown())
  .describe("The form template body with its `design` document ({settings, questions, sections, conditions, layout})");

const formsRead = defineOpTool({
  name: "forms.read",
  description:
    "Read ProForma forms: list a project's form templates (listFormTemplates), get one with its full design (getFormTemplate), get the portal form attached to a request type (getRequestTypeForm), list forms on an issue (listIssueForms), or get a submitted issue form's answers (getIssueFormAnswers).",
  group: "read_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "listFormTemplates",
      description: "List the form templates of a project (portal request forms / intake forms live here).",
      legacyName: "forms.listFormTemplates",
      input: { projectIdOrKey },
      handler: async (input, ctx) => {
        const resp = await ctx.client.forms().get<unknown>(projectPath(input.projectIdOrKey));
        return resp.data;
      },
    }),
    defineOp({
      op: "getFormTemplate",
      description: "Get a project form template by id, including its full `design` document (use this to export/adapt).",
      legacyName: "forms.getFormTemplate",
      input: { projectIdOrKey, formId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .forms()
          .get<unknown>(`${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getRequestTypeForm",
      description: "Get the portal form attached to a JSM request type (404 if the request type has no form).",
      legacyName: "forms.getRequestTypeForm",
      input: { serviceDeskId, requestTypeId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .forms()
          .get<unknown>(
            `${BASE}/servicedesk/${encodeURIComponent(input.serviceDeskId)}/requesttype/${encodeURIComponent(input.requestTypeId)}/form`,
          );
        return resp.data;
      },
    }),
    defineOp({
      op: "listIssueForms",
      description: "List the forms attached to an issue/request (agent view).",
      legacyName: "forms.listIssueForms",
      input: { issueIdOrKey },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .forms()
          .get<unknown>(`${BASE}/issue/${encodeURIComponent(input.issueIdOrKey)}/form`);
        return resp.data;
      },
    }),
    defineOp({
      op: "getIssueFormAnswers",
      description: "Get a submitted issue form's answers in simplified format (formId is the ISSUE form id).",
      legacyName: "forms.getIssueFormAnswers",
      input: { issueIdOrKey, formId },
      handler: async (input, ctx) => {
        const resp = await ctx.client
          .forms()
          .get<unknown>(
            `${BASE}/issue/${encodeURIComponent(input.issueIdOrKey)}/form/${encodeURIComponent(input.formId)}/format/answers`,
          );
        return resp.data;
      },
    }),
  ],
});

const formsManageTemplate = defineOpTool({
  name: "forms.manageTemplate",
  description:
    "Create a ProForma form template on a project (createFormTemplate) or replace one in place — rename, edit the design, attach to portal request types (updateFormTemplate). Both revertible.",
  group: "write_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  ops: [
    defineOp({
      op: "createFormTemplate",
      description:
        "Create a form template on a project. `form` must contain a `design` document — export an existing template with forms.read getFormTemplate for the shape.",
      destructive: true,
      legacyName: "forms.createFormTemplate",
      input: { projectIdOrKey, form: formDocument },
      handler: async (input, ctx, meta) => {
        const dry = meta.dryRun({
          target: { kind: "form_template", name: (input.form as { name?: string }).name ?? "(unnamed)" },
          before: null,
          after: input.form,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting a template create = delete it. The project path is required
      // by the API, so it is journaled in `request`.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        const project = (entry.request as { projectIdOrKey?: string } | null)?.projectIdOrKey;
        if (!id || !project) throw new Error("Cannot revert: created form id or project missing from the journal entry.");
        await ctx.client.forms().delete<unknown>(`/project/${encodeURIComponent(project)}/form/${encodeURIComponent(id)}`);
        return { deleted: id };
      },
    }),
    defineOp({
      op: "updateFormTemplate",
      description: "Replace a form template in place. Captures full before/after; revertible.",
      destructive: true,
      legacyName: "forms.updateFormTemplate",
      input: { projectIdOrKey, formId, form: formDocument },
      handler: async (input, ctx, meta) => {
        const path = `${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`;
        const before = await ctx.client.forms().get<unknown>(path);
        const dry = meta.dryRun({
          target: { kind: "form_template", id: input.formId },
          before: before.data,
          after: input.form,
        });
        if (dry) return dry;
        const entry = await ctx.journalOp({
          ...ctx.defaultJournalArgs,
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
      // Reverting an update = PUT the captured before back.
      revert: async (entry, anyCtx) => {
        const ctx = anyCtx as ToolContext;
        const id = (entry.target as { id?: string }).id;
        const project = (entry.request as { projectIdOrKey?: string } | null)?.projectIdOrKey;
        if (!id || !project) throw new Error("Cannot revert: form id or project missing from the journal entry.");
        if (!entry.before) throw new Error("Cannot revert: journal entry has no captured `before` template.");
        const resp = await ctx.client
          .forms()
          .put<unknown>(`/project/${encodeURIComponent(project)}/form/${encodeURIComponent(id)}`, entry.before);
        return { reverted: id, response: resp.data };
      },
    }),
  ],
});

const formsDelete = defineTool({
  name: "forms.delete",
  description:
    "Delete a project form template. **Irreversible** — the full template (design included) is captured in the " +
    "journal `before` for manual re-creation.",
  group: "write_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  destructive: true,
  legacyName: "forms.deleteFormTemplate",
  input: { projectIdOrKey: z.string().min(1), formId: z.string().min(1), commit: z.boolean().optional() },
  handler: async (input, ctx) => {
    const path = `${projectPath(input.projectIdOrKey)}/${encodeURIComponent(input.formId)}`;
    const before = await ctx.client.forms().get<unknown>(path);
    if (input.commit !== true) {
      return buildDeleteDryRun({
        tool: "forms.delete",
        target: { kind: "form_template", id: input.formId },
        before: before.data,
      });
    }
    const entry = await ctx.journalOp({
      ...ctx.defaultJournalArgs,
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
});

export const formsTools = (): AnyToolDef[] => [formsRead, formsManageTemplate, formsDelete];

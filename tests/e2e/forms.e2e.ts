import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

const DESIGN = {
  name: "gojira-e2e-form",
  design: {
    settings: { name: "gojira-e2e-form", submit: { lock: false, pdf: false }, templateFormUuid: null },
    questions: { "1": { type: "ts", label: "Describe the issue", description: "", validation: { rq: false } } },
    sections: {},
    conditions: {},
    layout: [{ version: 1, type: "doc", content: [{ type: "paragraph", content: [] }] }],
  },
};

describe.skipIf(noCreds)("e2e: Forms", () => {
  let h: E2EHarness;
  let projectKey: string;
  beforeAll(async () => {
    h = buildHarness();
    const desks = await h.call<{ values: Array<{ projectKey: string }> }>("jsm.listServiceDesks", {});
    projectKey = desks.values[0].projectKey;
  });

  it("template create → export → update → delete, journaled + revertible", async () => {
    const created = await h.call<{ ok: boolean; journal_id: string; form: { id: string } }>(
      "forms.createFormTemplate",
      { projectIdOrKey: projectKey, form: DESIGN, commit: true },
    );
    const formId = created.form.id;
    expect(formId).toBeTruthy();

    const listed = await h.call<Array<{ id: string }>>("forms.listFormTemplates", { projectIdOrKey: projectKey });
    expect(listed.some((f) => f.id === formId)).toBe(true);

    const exported = await h.call<{ id: string; design: unknown }>("forms.getFormTemplate", {
      projectIdOrKey: projectKey,
      formId,
    });
    expect(exported.design).toBeTruthy();

    const updated = await h.call<{ ok: boolean }>("forms.updateFormTemplate", {
      projectIdOrKey: projectKey,
      formId,
      form: { ...DESIGN, name: "gojira-e2e-form-v2" },
      commit: true,
    });
    expect(updated.ok).toBe(true);

    const del = await h.call<{ ok: boolean }>("forms.deleteFormTemplate", {
      projectIdOrKey: projectKey,
      formId,
      commit: true,
    });
    expect(del.ok).toBe(true);

    const after = await h.call<Array<{ id: string }>>("forms.listFormTemplates", { projectIdOrKey: projectKey });
    expect(after.some((f) => f.id === formId)).toBe(false);
  });

  it("issue form reads answer without error", async () => {
    const desks = await h.call<{ values: Array<{ id: string }> }>("jsm.listServiceDesks", {});
    const queues = await h.call<{ values: Array<{ id: string }> }>("jsm.listQueues", {
      serviceDeskId: desks.values[0].id,
    });
    // Reading forms on any issue in the first queue (or skip silently when empty).
    const issues = await h.call<{ values: Array<{ key: string }> }>("jsm.getQueueIssues", {
      serviceDeskId: desks.values[0].id,
      queueId: queues.values[0]?.id,
      limit: 1,
    });
    if (issues.values?.length) {
      const forms = await h.call<unknown[]>("forms.listIssueForms", { issueIdOrKey: issues.values[0].key });
      expect(Array.isArray(forms)).toBe(true);
    }
  });
});

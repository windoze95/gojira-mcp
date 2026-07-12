import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

/**
 * Battle-test of gojira.revertOperation against the live tenant — the revert
 * pipeline (journal → reverter registry → API-token client) was systemically
 * broken once; this guards the fix end-to-end.
 */
describe.skipIf(noCreds)("e2e: revertOperation", () => {
  let h: E2EHarness;
  let projectKey: string;
  beforeAll(async () => {
    h = buildHarness();
    const desks = await h.call<{ values: Array<{ projectKey: string }> }>("jsm.listServiceDesks", {});
    projectKey = desks.values[0].projectKey;
  });

  it("reverts a form-template create (delete via the API-token client)", async () => {
    const created = await h.call<{ journal_id: string; form: { id: string } }>("forms.createFormTemplate", {
      projectIdOrKey: projectKey,
      form: {
        name: "gojira-e2e-revert-form",
        design: {
          settings: { name: "gojira-e2e-revert-form", submit: { lock: false, pdf: false }, templateFormUuid: null },
          questions: {},
          sections: {},
          conditions: {},
          layout: [{ version: 1, type: "doc", content: [] }],
        },
      },
      commit: true,
    });

    // dry-run shows the original op
    const dry = await h.call<{ dry_run: boolean; original: { tool: string } }>("gojira.revertOperation", {
      op_id: created.journal_id,
    });
    expect(dry.dry_run).toBe(true);
    expect(dry.original.tool).toBe("forms.createFormTemplate");

    // committed revert deletes the template on the live tenant
    const reverted = await h.call<{ reverted: boolean }>("gojira.revertOperation", {
      op_id: created.journal_id,
      commit: true,
    });
    expect(reverted.reverted).toBe(true);

    const after = await h.call<Array<{ id: string }>>("forms.listFormTemplates", { projectIdOrKey: projectKey });
    expect(after.some((f) => f.id === created.form.id)).toBe(false);
  });

  it("refuses to revert an irreversible op", async () => {
    // deleteRequestType journals revertible:false — grab any journal entry of a
    // fresh create+delete cycle and confirm the delete refuses.
    const rts = await h.call<{ values: Array<{ issueTypeId: string }> }>("jsm.listRequestTypes", {
      serviceDeskId: (await h.call<{ values: Array<{ id: string }> }>("jsm.listServiceDesks", {})).values[0].id,
    });
    const serviceDeskId = (await h.call<{ values: Array<{ id: string }> }>("jsm.listServiceDesks", {})).values[0].id;
    await h.call("jsm.createRequestType", {
      serviceDeskId,
      issueTypeId: rts.values[0].issueTypeId,
      name: "gojira-e2e-revert-rt",
      commit: true,
    });
    const list = await h.call<{ values: Array<{ id: string; name: string }> }>("jsm.listRequestTypes", {
      serviceDeskId,
    });
    const probe = list.values.find((v) => v.name === "gojira-e2e-revert-rt")!;
    const del = await h.call<{ ok: boolean; journal_id: string }>("jsm.deleteRequestType", {
      serviceDeskId,
      requestTypeId: probe.id,
      commit: true,
    });
    const refuse = await h.callRaw("gojira.revertOperation", { op_id: del.journal_id, commit: true });
    expect(refuse.isError).toBe(true);
  });
});

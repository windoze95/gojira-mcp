import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

/**
 * Regression cover for the single-field-GET bug: the custom-field read paths
 * used `GET /rest/api/3/field/{fieldId}`, which Jira Cloud answers with **405**
 * (that path is PUT/DELETE only). Every call failed, and the unit suite
 * couldn't see it because nothing exercised the real API. These read paths now
 * go through `/field/search?id=`.
 *
 * Post-collapse names: customfields.read / customfields.manage with `op`.
 *
 * OAuth-path suite: skipped unless E2E_OAUTH_ACCESS_TOKEN is set.
 */
describe.skipIf(noCreds || !process.env.E2E_OAUTH_ACCESS_TOKEN)("e2e: custom fields (OAuth path)", () => {
  let h: E2EHarness;
  let fieldId: string;

  beforeAll(async () => {
    h = buildHarness();
    const list = await h.call<{ values: Array<{ id: string; custom?: boolean }> }>("customfields.read", {
      op: "listCustomFields",
      maxResults: 50,
    });
    fieldId = list.values.find((f) => f.custom)?.id ?? list.values[0].id;
  });

  it("reads a single custom field (the path that used to 405)", async () => {
    const field = await h.call<{ id: string }>("customfields.read", { op: "getCustomField", fieldId });
    expect(field.id).toBe(fieldId);
  });

  it("reads a custom field with its contexts", async () => {
    const res = await h.call<{ field: { id: string }; contexts: unknown }>("customfields.read", {
      op: "getCustomField",
      fieldId,
      includeContexts: true,
    });
    expect(res.field.id).toBe(fieldId);
    expect(res.contexts).toBeTruthy();
  });

  it("update dry-run captures a real before-snapshot (405 would have broken this)", async () => {
    // Dry-run only: no commit, so nothing mutates — but it exercises the
    // before-capture read that the 405 bug used to blow up on. The diff is a
    // JSON patch computed FROM that snapshot, so a non-empty diff proves the
    // capture succeeded (a 405 would have failed the call outright).
    const dry = await h.call<{ dry_run: boolean; tool: string; diff?: { patch?: unknown[] } }>(
      "customfields.manage",
      {
        op: "updateCustomField",
        fieldId,
        description: "gojira-e2e probe (dry-run only, never committed)",
      },
    );
    expect(dry.dry_run).toBe(true);
    expect(dry.tool).toBe("customfields.manage"); // what the confirm card would re-invoke
    expect(dry.diff).toBeTruthy();
  });
});

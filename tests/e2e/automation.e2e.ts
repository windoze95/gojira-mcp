import { describe, expect, it, beforeAll } from "vitest";
import { buildHarness, noCreds, e2eCreds } from "./harness.js";
import type { E2EHarness } from "./harness.js";

describe.skipIf(noCreds)("e2e: Automation rules", () => {
  let h: E2EHarness;
  beforeAll(() => {
    h = buildHarness();
  });

  it("lists rules and searches templates", async () => {
    const list = await h.call<{ data: unknown[] }>("automation.listAutomationRules", {});
    expect(Array.isArray(list.data)).toBe(true);
    const templates = await h.call<{ data: Array<{ id: string }> }>("automation.searchAutomationTemplates", {
      payload: {},
    });
    expect(templates.data.length).toBeGreaterThan(0);
  });

  it("full rule lifecycle: create-from-template → export → raw create → toggle → delete", async () => {
    const creds = e2eCreds()!;
    // Find a project to scope the rule to.
    const desks = await h.call<{ values: Array<{ projectId?: string; projectKey: string }> }>(
      "jsm.listServiceDesks",
      {},
    );
    const projectId = desks.values[0].projectId;
    const ruleHome = `ari:cloud:jira:${creds.cloudId}:project/${projectId}`;

    // Create from a parameterless template (walk the FULL catalog until one
    // takes — the compatible ITSM templates sit beyond page 1).
    const all: Array<{ id: string; parameters?: unknown[] }> = [];
    let cursor: string | null = null;
    do {
      const page = await h.call<{
        data: Array<{ id: string; parameters?: unknown[] }>;
        links?: { next?: string | null };
      }>("automation.searchAutomationTemplates", { payload: cursor ? { cursor } : {} });
      all.push(...page.data);
      cursor = page.links?.next ? new URLSearchParams(page.links.next.replace(/^\?/, "")).get("cursor") : null;
    } while (cursor && all.length < 400);
    const templates = { data: all };
    let ruleUuid: string | null = null;
    const errors: string[] = [];
    // Walk the whole catalog — most software/devops templates reject a JSM
    // project home ("Invalid template"); the first compatible ITSM template
    // (no parameters, no external connection) wins.
    for (const t of templates.data.filter((t) => !(t.parameters as unknown[])?.length)) {
      const res = await h.callRaw("automation.createRuleFromTemplate", {
        templateId: t.id,
        ruleHome,
        commit: true,
      });
      if (!res.isError) {
        const env = res.body as { result?: { rule?: { ruleUuid?: string } } };
        ruleUuid = env.result?.rule?.ruleUuid ?? null;
        if (ruleUuid) break;
        errors.push(`${t.id}: 2xx but no ruleUuid in ${JSON.stringify(res.body).slice(0, 150)}`);
      } else {
        errors.push(`${t.id}: ${JSON.stringify(res.body).slice(0, 150)}`);
      }
    }
    expect(ruleUuid, `no template created a rule; first errors:\n${errors.slice(0, 3).join("\n")}`).toBeTruthy();

    // Export, then re-create raw.
    const exported = await h.call<{ rule: Record<string, unknown> }>("automation.getAutomationRule", {
      ruleId: ruleUuid!,
    });
    const clone = { ...exported.rule };
    for (const k of ["uuid", "id", "created", "updated", "ruleUuid"]) delete clone[k];
    clone.name = "gojira-e2e-raw-rule";
    clone.state = "DISABLED";
    const raw = await h.call<{ rule: { ruleUuid: string } }>("automation.createAutomationRule", {
      rule: clone,
      commit: true,
    });
    const rawUuid = raw.rule.ruleUuid;
    expect(rawUuid).toBeTruthy();

    // Toggle + delete both, verify gone.
    for (const id of [ruleUuid!, rawUuid]) {
      await h.call("automation.disableAutomationRule", { ruleId: id, commit: true });
      await h.call("automation.enableAutomationRule", { ruleId: id, commit: true });
      await h.call("automation.deleteAutomationRule", { ruleId: id, commit: true });
      const gone = await h.callRaw("automation.getAutomationRule", { ruleId: id });
      expect(gone.isError).toBe(true);
    }
  });
});

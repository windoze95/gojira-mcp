import { describe, expect, it, vi } from "vitest";
import { inspectRequestBuild } from "../../src/tools/defs/requestBuild.js";
import type { ToolContext } from "../../src/tools/types.js";

function response(data: unknown) {
  return { data, status: 200, meta: { nearLimit: false, rateLimitResetUnix: null, rateLimitRemaining: null } };
}

function buildCtx(rule: Record<string, unknown>): ToolContext {
  const jira = {
    get: vi.fn(async (path: string) => {
      if (path === "/rest/api/3/project/SYN") return response({ id: "100", key: "SYN" });
      if (path.endsWith("/requesttype/7")) return response({ id: "7", name: "Synthetic network request", issueTypeId: "22" });
      if (path.endsWith("/requesttype/7/field")) return response({ requestTypeFields: [{ fieldId: "summary" }] });
      if (path.endsWith("/requesttypegroup")) return response({ values: [{ id: "2", name: "Network" }] });
      if (path === "/rest/api/3/issuetype/22") return response({ id: "22", name: "Service Request" });
      if (path.startsWith("/rest/api/3/issue/SYN-9")) return response({ key: "SYN-9", fields: { summary: "Build" } });
      throw new Error(`Unexpected Jira path: ${path}`);
    }),
    post: vi.fn(async (path: string) => {
      expect(path).toBe("/rest/api/3/workflowscheme/read");
      return response([{ id: "5", name: "Synthetic workflow scheme", issueTypeMappings: { "22": "Synthetic workflow" } }]);
    }),
  };
  const forms = {
    get: vi.fn(async () => response({ id: "4", name: "Synthetic form", design: { questions: [] } })),
  };
  const automation = {
    get: vi.fn(async (path: string) => {
      expect(path).toBe("/rule/rule-1");
      return response(rule);
    }),
  };
  return {
    accountId: "acct",
    cloudId: "cloud",
    apiToken: { site_url: "synthetic.atlassian.net" },
    client: {
      apiTokenJira: () => jira,
      forms: () => forms,
      automation: () => automation,
    },
  } as unknown as ToolContext;
}

describe("jsm.inspectRequestBuild", () => {
  it("assembles pieces, canonical review links, and configured-but-unverified readiness", async () => {
    const result = (await inspectRequestBuild.handler(
      {
        spaceIdOrKey: "SYN",
        serviceDeskId: "3",
        requestTypeId: "7",
        automationRuleIds: ["rule-1"],
        trackingWorkItemIdOrKey: "SYN-9",
      },
      buildCtx({
        id: "rule-1",
        name: "Synthetic request automation",
        state: "ENABLED",
        trigger: { type: "WORK_ITEM_CREATED" },
        headers: { Authorization: "Bearer never-return-this" },
      }),
    )) as Record<string, any>;

    expect(result.readiness).toMatchObject({ state: "configured_unverified", liveVerified: false });
    expect(result.links.formDesigner).toBe(
      "https://synthetic.atlassian.net/jira/servicedesk/projects/SYN/settings/forms/form/4/edit",
    );
    expect(result.links.automationRules["rule-1"]).toContain("settings/automate#/rule/rule-1");
    expect(JSON.stringify(result.pieces.automation.rules)).not.toContain("never-return-this");
    expect(JSON.stringify(result.pieces.automation.rules)).toContain("[REDACTED]");
    expect(result.terminology.public.item).toBe("work item");
    expect(result.terminology.restAdapter.item).toBe("issue");
  });

  it("flags enabled automation with placeholder endpoints for review", async () => {
    const result = (await inspectRequestBuild.handler(
      {
        spaceIdOrKey: "SYN",
        serviceDeskId: "3",
        requestTypeId: "7",
        automationRuleIds: ["rule-1"],
      },
      buildCtx({
        id: "rule-1",
        name: "Synthetic request automation",
        state: "ENABLED",
        action: { url: "https://awx.example.invalid/api/v2/job_templates/1/launch/" },
      }),
    )) as Record<string, any>;

    expect(result.readiness.state).toBe("needs_review");
    expect(result.readiness.counts.placeholderValues).toBe(1);
    expect(result.pieces.automation.placeholderValues[0].path).toContain("action.url");
  });
});

/**
 * Fixture scenarios for the local render harness. Payloads mirror the real
 * shapes: Atlassian REST bodies wrapped in gojira's {success, result}
 * envelope, and dry-runs exactly as src/consent/dryRun.ts emits them.
 */

export interface Scenario {
  /** Template file in ui/dist (without .html). */
  view: string;
  label: string;
  /** Arguments the host replays via ui/notifications/tool-input. */
  toolArgs: Record<string, unknown>;
  /** Initial tool result payload (the `result` inside the envelope). */
  result: unknown;
  /** Responses for view-initiated tools/call, keyed by tool name. */
  calls?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  /** Render an error envelope instead of a success one. */
  error?: { code: string; message: string; details?: unknown; reference_id?: string };
}

const PERMISSION_SCHEME_BEFORE = {
  id: 10200,
  name: "Payments Platform: Permission Scheme",
  description: "Grants for the Payments Platform project",
  permissions: [
    { id: 100420, holder: { type: "projectRole", parameter: "10002", value: "10002" }, permission: "ADMINISTER_PROJECTS" },
    { id: 100421, holder: { type: "applicationRole", value: "jira-software" }, permission: "BROWSE_PROJECTS" },
    { id: 100422, holder: { type: "group", parameter: "payments-engineers", value: "8a1b39c4-payments" }, permission: "CREATE_ISSUES" },
    { id: 100423, holder: { type: "group", parameter: "payments-engineers", value: "8a1b39c4-payments" }, permission: "EDIT_ISSUES" },
    { id: 100424, holder: { type: "projectRole", parameter: "10002", value: "10002" }, permission: "DELETE_ISSUES" },
  ],
};

const PERMISSION_SCHEME_AFTER = {
  ...PERMISSION_SCHEME_BEFORE,
  description: "Grants for the Payments Platform project (SOX-scoped)",
  permissions: [
    PERMISSION_SCHEME_BEFORE.permissions[0],
    PERMISSION_SCHEME_BEFORE.permissions[1],
    PERMISSION_SCHEME_BEFORE.permissions[2],
    { id: 100423, holder: { type: "group", parameter: "payments-approvers", value: "44de0ec1-approvers" }, permission: "EDIT_ISSUES" },
  ],
};

const PROJECT_BEFORE = {
  id: "10471",
  key: "PAYX",
  name: "Payments Experiments",
  projectTypeKey: "software",
  simplified: false,
  style: "classic",
  lead: { accountId: "5f2b9c11a4d3e80071a3b6d2", displayName: "Dana Okonkwo", active: true },
  components: [
    { id: "10530", name: "checkout-api" },
    { id: "10531", name: "ledger-sync" },
  ],
  issueTypes: [
    { id: "10001", name: "Story" },
    { id: "10002", name: "Bug" },
    { id: "10003", name: "Task" },
  ],
};

const RULE_DOC = {
  id: "b31f6a24-8d5e-4c17-9f0a-2e6c7d1b4a93",
  name: "Auto-triage payment failures",
  state: "ENABLED",
  description: "Route failed-payment bugs to the on-call queue and escalate criticals.",
  ruleScope: { resources: ["ari:cloud:jira:9c1e4f3a-0000-4b1e-a111-8f2d6c5b7a10:project/10471"] },
  trigger: {
    component: "TRIGGER",
    type: "jira.issue.event.trigger:created",
    value: { synchronous: false },
  },
  components: [
    {
      component: "CONDITION",
      type: "jira.issue.condition",
      value: {
        selectedField: { type: "ID", value: "labels" },
        selectedFieldType: "LABELS",
        comparison: "CONTAINS",
        compareValue: { type: "RAW", value: "payment-failure" },
      },
    },
    {
      component: "CONDITION_BLOCK",
      type: "jira.condition.container.block",
      conditions: [
        {
          component: "CONDITION",
          type: "jira.issue.condition",
          value: { selectedField: { type: "ID", value: "priority" }, comparison: "EQUALS", compareValue: { type: "ID", value: "1" } },
        },
      ],
      children: [
        {
          component: "ACTION",
          type: "jira.issue.assign",
          value: { assignee: { type: "SMART_VALUE", value: "{{oncall.accountId}}" }, sendNotification: true },
        },
        {
          component: "ACTION",
          type: "slack.send.message",
          value: { channel: "#payments-oncall", message: "Critical payment failure: {{issue.key}} — {{issue.summary}}" },
        },
      ],
    },
    {
      component: "ACTION",
      type: "jira.issue.edit",
      value: {
        operations: [{ field: { type: "ID", value: "customfield_10310" }, type: "SET", value: { type: "RAW", value: "Payments On-Call" } }],
      },
    },
    {
      component: "ACTION",
      type: "jira.issue.transition",
      value: { transition: { id: "31", name: "Triage" }, comment: { body: "Auto-triaged by rule." } },
    },
  ],
};

const JOURNAL_ENTRIES = [
  {
    op_id: "1f7c0a3e-5b42-4d9a-8e11-6c2b7f4d9a01",
    tool: "schemes.managePermission",
    target: { kind: "permission_scheme", id: "10200", name: "Payments Platform: Permission Scheme" },
    completed_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    outcome: "success",
    revertible: true,
    error_code: null,
  },
  {
    op_id: "2b8d1c4f-6a73-42e8-9d05-7f3c8e2a1b42",
    tool: "customfields.manage",
    target: { kind: "custom_field", id: "customfield_10310", name: "Support Team" },
    completed_at: new Date(Date.now() - 47 * 60 * 1000).toISOString(),
    outcome: "success",
    revertible: false,
    error_code: null,
  },
  {
    op_id: "3c9e2d5a-7b84-4f19-ae26-8a4d9f3b2c53",
    tool: "assets.delete",
    target: { kind: "asset_object", id: "1042", key: "HW-1042", name: "MBP-14 · dana.okonkwo" },
    completed_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    outcome: "success",
    revertible: true,
    error_code: null,
  },
  {
    op_id: "4da13e6b-8c95-4a2b-bf37-9b5eaf4c3d64",
    tool: "automation.manageRule",
    target: { kind: "automation_rule", id: "b31f6a24-8d5e-4c17-9f0a-2e6c7d1b4a93", name: "Auto-triage payment failures" },
    completed_at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    outcome: "failure",
    revertible: false,
    error_code: "INSUFFICIENT_PERMISSIONS",
  },
  {
    op_id: "5eb24f7c-9da6-4b3c-c048-ac6fb05d4e75",
    tool: "jsm.manage",
    target: { kind: "jsm_request_type", id: "217", name: "Corporate card request" },
    completed_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    outcome: "success",
    revertible: true,
    error_code: null,
  },
];

const JOURNAL_DETAIL: Record<string, unknown> = {
  "1f7c0a3e-5b42-4d9a-8e11-6c2b7f4d9a01": {
    opId: "1f7c0a3e-5b42-4d9a-8e11-6c2b7f4d9a01",
    accountId: "5f2b9c11a4d3e80071a3b6d2",
    tool: "schemes.managePermission",
    cloudId: "9c1e4f3a-0000-4b1e-a111-8f2d6c5b7a10",
    target: { kind: "permission_scheme", id: "10200", name: "Payments Platform: Permission Scheme" },
    before: PERMISSION_SCHEME_BEFORE,
    after: PERMISSION_SCHEME_AFTER,
    request: { op: "updatePermissionScheme", schemeId: "10200" },
    requestedAt: new Date(Date.now() - 4 * 60 * 1000 - 800).toISOString(),
    completedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    outcome: "success",
    revertible: true,
    revertHint: "PUT the previous permissions array back onto scheme 10200.",
  },
};

const AQL_RESULT = {
  startAt: 0,
  maxResults: 25,
  total: 118,
  isLast: false,
  objectTypeAttributes: [
    { id: "1842", name: "Serial number" },
    { id: "1843", name: "Owner" },
    { id: "1844", name: "Status" },
    { id: "1845", name: "Model" },
    { id: "1846", name: "Purchase date" },
    { id: "1847", name: "Warranty ends" },
    { id: "1848", name: "Location" },
  ],
  values: [
    mkObject("1041", "HW-1041", "MBP-16 · sam.reyes", "Laptop", {
      1842: "C02XK1YQMD6T",
      1843: "Sam Reyes",
      1844: "In use",
      1845: 'MacBook Pro 16" M3 Max',
      1846: "2025-03-11",
      1847: "2028-03-11",
      1848: "Austin HQ · Floor 4",
    }),
    mkObject("1043", "HW-1043", "MBP-14 · priya.raman", "Laptop", {
      1842: "C02ZK9PLND2Q",
      1843: "Priya Raman",
      1844: "In use",
      1845: 'MacBook Pro 14" M3 Pro',
      1846: "2025-06-02",
      1847: "2028-06-02",
      1848: "Remote · IN",
    }),
    mkObject("1044", "HW-1044", "TB-Dock · lab-3", "Docking station", {
      1842: "DK77120041",
      1843: "IT Lab",
      1844: "Spare",
      1845: "CalDigit TS4",
      1846: "2024-11-19",
      1847: "2026-11-19",
      1848: "Austin HQ · Lab 3",
    }),
    mkObject("1047", "HW-1047", "XPS-15 · marta.kovac", "Laptop", {
      1842: "9QK4TX3",
      1843: "Marta Kovač",
      1844: "Repair",
      1845: "Dell XPS 15 9530",
      1846: "2024-08-27",
      1847: "2027-08-27",
      1848: "Berlin · Floor 2",
    }),
    mkObject("1052", "HW-1052", "iPad-Air · field-kit-2", "Tablet", {
      1842: "DMPXK0PTQ1GC",
      1843: "Field Ops",
      1844: "In use",
      1845: "iPad Air 13 M2",
      1846: "2025-01-30",
      1847: "2027-01-30",
      1848: "Field kit 2",
    }),
    mkObject("1058", "HW-1058", "MBA-13 · contractor-pool", "Laptop", {
      1842: "C1MVL3D8Q6NY",
      1843: "Contractor pool",
      1844: "Spare",
      1845: 'MacBook Air 13" M2',
      1846: "2024-05-14",
      1847: "2027-05-14",
      1848: "Austin HQ · Store",
    }),
  ],
};

function mkObject(
  id: string,
  key: string,
  label: string,
  typeName: string,
  attrs: Record<string, string>,
): Record<string, unknown> {
  return {
    id,
    objectKey: key,
    label,
    objectType: { id: "184", name: typeName },
    created: "2025-03-11T09:14:22.000Z",
    attributes: [
      ...Object.entries(attrs).map(([attrId, v]) => ({
        objectTypeAttributeId: Number(attrId),
        objectAttributeValues: [{ value: v, displayValue: v }],
      })),
    ],
  };
}

const RULE_SUMMARIES = {
  values: [
    { id: RULE_DOC.id, name: RULE_DOC.name, state: "ENABLED" },
    { id: "c42a7b35-9e6f-4d28-a01b-3f7d8e2c5b04", name: "Close stale support requests", state: "ENABLED" },
    { id: "d53b8c46-af70-4e39-b12c-4a8e9f3d6c15", name: "Sync epics to roadmap board", state: "DISABLED" },
    { id: "e64c9d57-b081-4f4a-c23d-5b9fa04e7d26", name: "Notify SRE on Sev-1 linked incident", state: "ENABLED" },
  ],
  links: { next: "https://api.atlassian.com/automation/…/rule/summary?cursor=eyJvZmZzZXQiOjR9&limit=50" },
};

export const SCENARIOS: Record<string, Scenario> = {
  "confirm-scheme": {
    view: "confirm-op",
    label: "Confirm card — permission scheme (PUT-replace diff)",
    toolArgs: { op: "updatePermissionScheme", schemeId: "10200", permissions: PERMISSION_SCHEME_AFTER.permissions },
    result: {
      dry_run: true,
      tool: "schemes.managePermission",
      message:
        "This call REPLACES the scheme's permissions array — grants omitted from your payload are dropped. Re-invoke with `commit: true` to apply the diff below.",
      target: { kind: "permission_scheme", id: "10200", name: "Payments Platform: Permission Scheme" },
      diff: {
        patch: [
          { op: "replace", path: "/description", value: PERMISSION_SCHEME_AFTER.description },
          { op: "replace", path: "/permissions", value: PERMISSION_SCHEME_AFTER.permissions },
        ],
        before: PERMISSION_SCHEME_BEFORE,
        after: PERMISSION_SCHEME_AFTER,
      },
      commit_hint: "Re-invoke this tool with the same arguments and `commit: true` to apply.",
    },
    calls: {
      "schemes.managePermission": { ok: true, journal_id: "1f7c0a3e-5b42-4d9a-8e11-6c2b7f4d9a01" },
    },
  },

  "confirm-delete-permanent": {
    view: "confirm-op",
    label: "Confirm card — permanent project delete (NO UNDO)",
    toolArgs: { project: "PAYX", permanent: true },
    result: {
      dry_run: true,
      tool: "projects.delete",
      message: "Would PERMANENTLY DELETE the project. Re-invoke with commit:true to apply. NO UNDO.",
      target: { kind: "jira_project", id: "PAYX", key: "PAYX", name: "Payments Experiments" },
      diff: { before: PROJECT_BEFORE, after: null },
      commit_hint: "Re-invoke this tool with `commit: true` to perform the deletion.",
    },
    calls: {
      "projects.delete": { ok: true, journal_id: "9f3a1b7c-2d4e-4a6b-8c0d-1e5f7a9b3c2d" },
    },
  },

  "confirm-committed": {
    view: "confirm-op",
    label: "Confirm card — committed result",
    toolArgs: { project: "PAYX", permanent: false, commit: true },
    result: { ok: true, journal_id: "9f3a1b7c-2d4e-4a6b-8c0d-1e5f7a9b3c2d" },
  },

  "confirm-error": {
    view: "confirm-op",
    label: "Confirm card — error envelope",
    toolArgs: { ruleId: "b31f6a24-8d5e-4c17-9f0a-2e6c7d1b4a93", commit: true },
    result: null,
    error: {
      code: "INSUFFICIENT_PERMISSIONS",
      message:
        "Atlassian rejected the call: the bound API token's account is not a Jira administrator (ADMINISTER global permission required for automation writes).",
      details: { status: 403, endpoint: "PUT /rule/b31f6a24-8d5e-4c17-9f0a-2e6c7d1b4a93" },
      reference_id: "err_7c1d9a2f",
    },
  },

  journal: {
    view: "journal",
    label: "Journal timeline",
    toolArgs: { limit: 25 },
    result: { count: JOURNAL_ENTRIES.length, entries: JOURNAL_ENTRIES },
    calls: {
      // Post-collapse: the journal template calls one tool with an op field.
      "gojira.readJournal": (args) =>
        args.op === "getOperation"
          ? (JOURNAL_DETAIL[String(args.op_id)] ?? JOURNAL_DETAIL[JOURNAL_ENTRIES[0].op_id])
          : { count: JOURNAL_ENTRIES.length, entries: JOURNAL_ENTRIES },
      "gojira.revertOperation": (args) =>
        args.commit === true
          ? {
              reverted: true,
              result: { id: 10200, updated: true },
              journal_id: "7a2c4e91-3b5d-4f68-9a0c-2d8e6b1f4a37",
              original_op_id: String(args.op_id),
            }
          : {
              dry_run: true,
              tool: "gojira.revertOperation",
              message: `Would revert operation ${String(args.op_id)} (schemes.managePermission). Re-invoke with commit:true to apply.`,
              target: { kind: "permission_scheme", id: "10200", name: "Payments Platform: Permission Scheme" },
              diff: {
                patch: [
                  { op: "replace", path: "/description", value: PERMISSION_SCHEME_BEFORE.description },
                  { op: "replace", path: "/permissions", value: PERMISSION_SCHEME_BEFORE.permissions },
                ],
                before: PERMISSION_SCHEME_AFTER,
                after: PERMISSION_SCHEME_BEFORE,
              },
              commit_hint: "Re-invoke this tool with the same arguments and `commit: true` to apply.",
              original: { op_id: String(args.op_id), tool: "schemes.managePermission" },
            },
    },
  },

  aql: {
    view: "aql-table",
    label: "Assets AQL results table",
    toolArgs: {
      qlQuery: 'objectType = "Laptop" OR objectType = "Tablet" AND Status != "Retired" ORDER BY "Purchase date" DESC',
      page: 1,
      resultPerPage: 25,
      includeAttributes: true,
    },
    result: AQL_RESULT,
    calls: {
      "assets.aqlSearch": (args) => ({
        ...AQL_RESULT,
        startAt: ((Number(args.page) || 1) - 1) * 25,
        values: AQL_RESULT.values.slice(0, 4),
      }),
    },
  },

  "automation-rule": {
    view: "automation-rule",
    label: "Automation rule inspector — single rule",
    toolArgs: { ruleId: RULE_DOC.id },
    result: RULE_DOC,
  },

  "automation-list": {
    view: "automation-rule",
    label: "Automation rule inspector — rule list",
    toolArgs: { limit: 50 },
    result: RULE_SUMMARIES,
    calls: {
      // Post-collapse: one tool, op-dispatched.
      "automation.readRule": (args) => (args.op === "getAutomationRule" ? RULE_DOC : RULE_SUMMARIES),
    },
  },
};

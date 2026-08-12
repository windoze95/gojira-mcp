import { z } from "zod";
import type { AtlassianClient } from "../../atlassian/client.js";
import { AtlassianApiError } from "../../atlassian/errors.js";
import type { AnyToolDef } from "./defineTool.js";
import { defineTool } from "./defineTool.js";
import { REQUEST_BUILD_UI_URI } from "../../ui/appResources.js";

const SD = "/rest/servicedeskapi";
const API = "/rest/api/3";
const SECRET_KEY_RE = /token|secret|password|authorization|api[_-]?key|credential|cookie|private[_-]?key/i;
const PLACEHOLDER_RE = /(?:\.invalid\b|example\.(?:com|org|net)\b|localhost\b|127\.0\.0\.1\b|\bTODO\b|<[^>]+>)/i;

type JsonRecord = Record<string, unknown>;

interface Inspection<T = unknown> {
  ok: boolean;
  data: T | null;
  error: string | null;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function valuesOf(value: unknown): JsonRecord[] {
  const record = asRecord(value);
  const rows = Array.isArray(record?.values)
    ? record.values
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(value)
        ? value
        : [];
  return rows.map(asRecord).filter((row): row is JsonRecord => row !== null);
}

function errorMessage(error: unknown): string {
  if (error instanceof AtlassianApiError) return `Atlassian API returned ${error.statusCode}`;
  return error instanceof Error ? error.message : String(error);
}

async function inspect<T>(run: () => Promise<T>): Promise<Inspection<T>> {
  try {
    return { ok: true, data: await run(), error: null };
  } catch (error) {
    return { ok: false, data: null, error: errorMessage(error) };
  }
}

async function inspectOptional404<T>(run: () => Promise<T>): Promise<Inspection<T>> {
  try {
    return { ok: true, data: await run(), error: null };
  } catch (error) {
    if (error instanceof AtlassianApiError && error.statusCode === 404) {
      return { ok: true, data: null, error: null };
    }
    return { ok: false, data: null, error: errorMessage(error) };
  }
}

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[TRUNCATED]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1);
  }
  return out;
}

function collectPlaceholderStrings(value: unknown, path = "$", out: Array<{ path: string; value: string }> = []) {
  if (typeof value === "string") {
    if (PLACEHOLDER_RE.test(value)) out.push({ path, value });
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPlaceholderStrings(item, `${path}[${index}]`, out));
  } else {
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      if (!SECRET_KEY_RE.test(key)) collectPlaceholderStrings(item, `${path}.${key}`, out);
    }
  }
  return out;
}

function safePlaceholderValue(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString().slice(0, 300);
  } catch {
    return value
      .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]")
      .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, "$1[REDACTED]")
      .slice(0, 300);
  }
}

function automationCursor(page: JsonRecord): string | null {
  if (typeof page.cursor === "string") return page.cursor;
  const links = asRecord(page.links);
  if (typeof links?.next !== "string") return null;
  try {
    return new URL(links.next).searchParams.get("cursor");
  } catch {
    const match = /[?&]cursor=([^&]+)/.exec(links.next);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

async function listAutomationSummaries(client: AtlassianClient, maxRules: number): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20 && rows.length < maxRules; page++) {
    const params = new URLSearchParams({ limit: String(Math.min(100, maxRules - rows.length)) });
    if (cursor) params.set("cursor", cursor);
    const response = await client.get<JsonRecord>(`/rule/summary?${params.toString()}`);
    rows.push(...valuesOf(response.data));
    cursor = automationCursor(response.data);
    if (!cursor) break;
  }
  return rows.slice(0, maxRules);
}

function ruleState(rule: JsonRecord): string | null {
  const nested = asRecord(rule.rule);
  return asString(rule.state ?? nested?.state);
}

function ruleId(rule: JsonRecord): string | null {
  const nested = asRecord(rule.rule);
  return asString(rule.id ?? rule.uuid ?? rule.ruleUuid ?? nested?.id ?? nested?.uuid ?? nested?.ruleUuid);
}

function attachedFormId(form: unknown): string | null {
  const record = asRecord(form);
  const nested = asRecord(record?.form);
  return asString(record?.id ?? record?.formId ?? nested?.id ?? nested?.formId);
}

function requestTypeWorkTypeId(requestType: unknown): string | null {
  const record = asRecord(requestType);
  return asString(record?.issueTypeId ?? asRecord(record?.issueType)?.id);
}

function canonicalLinks(input: {
  site: string | null;
  projectKey: string;
  serviceDeskId: string;
  requestTypeId: string;
  formId: string | null;
  ruleIds: string[];
  trackingWorkItemIdOrKey?: string;
}) {
  if (!input.site) return null;
  const base = `https://${input.site.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  const project = encode(input.projectKey);
  return {
    portalRequest: `${base}/servicedesk/customer/portal/${encode(input.serviceDeskId)}/create/${encode(input.requestTypeId)}`,
    requestTypesSettings: `${base}/jira/servicedesk/projects/${project}/settings/request-types`,
    formsSettings: `${base}/jira/servicedesk/projects/${project}/settings/forms`,
    formDesigner: input.formId
      ? `${base}/jira/servicedesk/projects/${project}/settings/forms/form/${encode(input.formId)}/edit`
      : null,
    automationSettings: `${base}/jira/servicedesk/projects/${project}/settings/automate`,
    automationRules: Object.fromEntries(
      input.ruleIds.map((id) => [id, `${base}/jira/servicedesk/projects/${project}/settings/automate#/rule/${encode(id)}`]),
    ),
    trackingWorkItem: input.trackingWorkItemIdOrKey
      ? `${base}/browse/${encode(input.trackingWorkItemIdOrKey)}`
      : null,
  };
}

function inferReadiness(input: {
  expectForm: boolean;
  expectAutomation: boolean;
  expectTrackingWorkItem: boolean;
  form: Inspection;
  automationRules: Inspection<JsonRecord[]>;
  trackingWorkItem: Inspection | null;
  project: Inspection;
  requestType: Inspection;
  fields: Inspection;
  workType: Inspection | null;
  workflowScheme: Inspection | null;
  automationAssociation: "explicit" | "candidate";
  placeholders: Array<{ ruleId: string | null; path: string; value: string }>;
}) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!input.project.ok) blockers.push("Service space could not be read.");
  if (!input.requestType.ok) blockers.push("Request type could not be read.");
  if (!input.fields.ok) blockers.push("Request-type fields could not be read.");
  if (!input.workType) blockers.push("Underlying work type association is missing.");
  else if (!input.workType.ok) blockers.push("Underlying work type could not be read.");
  if (input.workflowScheme && !input.workflowScheme.ok) warnings.push("Workflow-scheme association could not be read.");
  if (input.expectForm && (!input.form.ok || input.form.data === null)) blockers.push("Expected form is not attached or could not be read.");
  if (input.expectTrackingWorkItem && (!input.trackingWorkItem?.ok || input.trackingWorkItem.data === null)) {
    blockers.push("Expected tracking work item was not provided or could not be read.");
  }

  const rules = input.automationRules.data ?? [];
  if (input.expectAutomation && (!input.automationRules.ok || rules.length === 0)) {
    blockers.push("Expected automation rule association is missing or unreadable.");
  }
  const states = rules.map(ruleState).filter((state): state is string => Boolean(state));
  const enabled = states.filter((state) => state === "ENABLED").length;
  const disabled = states.filter((state) => state === "DISABLED").length;
  if (enabled > 0 && disabled > 0) warnings.push("Associated automation rules have mixed enabled and disabled states.");
  if (input.placeholders.length > 0) warnings.push("Placeholder values remain in associated automation rules.");
  const candidateNeedsReview = input.automationAssociation === "candidate" && rules.length > 0;
  if (candidateNeedsReview) {
    warnings.push("Automation rules are name/id candidates, not confirmed request-type associations.");
  }

  let state: "incomplete" | "staged" | "needs_review" | "configured_unverified";
  if (blockers.length > 0) state = "incomplete";
  else if (candidateNeedsReview || (enabled > 0 && input.placeholders.length > 0)) state = "needs_review";
  else if (disabled > 0 || input.placeholders.length > 0 || (input.expectAutomation && states.length === 0)) state = "staged";
  else state = "configured_unverified";

  return {
    state,
    liveVerified: false,
    blockers,
    warnings,
    counts: { automationRules: rules.length, enabled, disabled, placeholderValues: input.placeholders.length },
    liveVerificationRequired: [
      "Submit the portal request as a representative requester.",
      "Confirm the automation audit log reaches its intended terminal branch.",
      "Confirm the resulting work-item status and requester notification behavior.",
    ],
  };
}

export const inspectRequestBuild = defineTool({
  name: "jsm.inspectRequestBuild",
  description:
    "Inspect one JSM request build in a single read-only call: request type, fields, groups, attached form, underlying work type and workflow scheme, selected or candidate automation rules, optional tracking work item, canonical review links, and staged-vs-configured readiness.",
  group: "read_jsm_admin",
  authMethod: "api_token",
  needsCloudId: true,
  readOnly: true,
  ui: { resourceUri: REQUEST_BUILD_UI_URI },
  input: {
    spaceIdOrKey: z.string().min(1).describe("Jira service space id or key (the REST adapter maps this to projectIdOrKey)"),
    serviceDeskId: z.string().min(1).describe("JSM service desk id"),
    requestTypeId: z.string().min(1).describe("JSM request type id"),
    automationRuleIds: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe("Known rule UUIDs. When omitted, summaries are scanned and name/id matches are returned as candidates."),
    trackingWorkItemIdOrKey: z.string().min(1).optional(),
    expectForm: z.boolean().default(true).optional(),
    expectAutomation: z.boolean().default(true).optional(),
    expectTrackingWorkItem: z.boolean().default(false).optional(),
    maxAutomationRules: z.number().int().positive().max(500).default(200).optional(),
  },
  handler: async (input, ctx) => {
    const jira = ctx.client.apiTokenJira();
    const forms = ctx.client.forms();
    const automation = ctx.client.automation();
    const requestTypePath = `${SD}/servicedesk/${encode(input.serviceDeskId)}/requesttype/${encode(input.requestTypeId)}`;

    const [project, requestType, fields, groups, form, trackingWorkItem] = await Promise.all([
      inspect(async () => (await jira.get<JsonRecord>(`${API}/project/${encode(input.spaceIdOrKey)}`)).data),
      inspect(async () => (await jira.get<JsonRecord>(requestTypePath)).data),
      inspect(async () => (await jira.get<JsonRecord>(`${requestTypePath}/field`)).data),
      inspect(async () =>
        (await jira.get<JsonRecord>(`${SD}/servicedesk/${encode(input.serviceDeskId)}/requesttypegroup`)).data,
      ),
      inspectOptional404(async () =>
        (
          await forms.get<JsonRecord>(
            `/servicedesk/${encode(input.serviceDeskId)}/requesttype/${encode(input.requestTypeId)}/form`,
          )
        ).data,
      ),
      input.trackingWorkItemIdOrKey
        ? inspect(async () =>
            (
              await jira.get<JsonRecord>(
                `${API}/issue/${encode(input.trackingWorkItemIdOrKey!)}?fields=summary,status,assignee,labels,description`,
              )
            ).data,
          )
        : Promise.resolve(null),
    ]);

    const workTypeId = requestTypeWorkTypeId(requestType.data);
    const projectId = asString(asRecord(project.data)?.id);
    const workType = workTypeId
      ? await inspect(async () => (await jira.get<JsonRecord>(`${API}/issuetype/${encode(workTypeId)}`)).data)
      : null;
    const workflowScheme = projectId
      ? await inspect(async () =>
          (await jira.post<unknown>(`${API}/workflowscheme/read`, { projectIds: [projectId] })).data,
        )
      : null;

    let automationRules: Inspection<JsonRecord[]>;
    let automationAssociation: "explicit" | "candidate";
    if (input.automationRuleIds?.length) {
      automationAssociation = "explicit";
      automationRules = await inspect(async () =>
        Promise.all(
          input.automationRuleIds!.map(async (id) => {
            const response = await automation.get<JsonRecord>(`/rule/${encode(id)}`);
            return response.data;
          }),
        ),
      );
    } else {
      automationAssociation = "candidate";
      automationRules = await inspect(async () => {
        const summaries = await listAutomationSummaries(automation, input.maxAutomationRules ?? 200);
        const requestTypeName = asString(asRecord(requestType.data)?.name)?.toLowerCase() ?? "";
        const requestTypeNeedle = input.requestTypeId.toLowerCase();
        return summaries.filter((summary) => {
          const serialized = JSON.stringify(summary).toLowerCase();
          const exactIdReference = [
            `\"requesttypeid\":\"${requestTypeNeedle}\"`,
            `\"requesttype\":\"${requestTypeNeedle}\"`,
            `/request-type/${requestTypeNeedle}`,
            `/requesttype/${requestTypeNeedle}`,
          ].some((needle) => serialized.includes(needle));
          return exactIdReference || (requestTypeName.length > 2 && serialized.includes(requestTypeName));
        });
      });
    }

    const placeholderValues = (automationRules.data ?? []).flatMap((rule) =>
      collectPlaceholderStrings(rule).map((match) => ({
        ruleId: ruleId(rule),
        path: match.path,
        value: safePlaceholderValue(match.value),
      })),
    );
    const formId = attachedFormId(form.data);
    const ruleIds = (automationRules.data ?? []).map(ruleId).filter((id): id is string => Boolean(id));
    const projectKey = asString(asRecord(project.data)?.key) ?? input.spaceIdOrKey;
    const links = canonicalLinks({
      site: ctx.apiToken?.site_url ?? null,
      projectKey,
      serviceDeskId: input.serviceDeskId,
      requestTypeId: input.requestTypeId,
      formId,
      ruleIds,
      trackingWorkItemIdOrKey: input.trackingWorkItemIdOrKey,
    });

    const readiness = inferReadiness({
      expectForm: input.expectForm ?? true,
      expectAutomation: input.expectAutomation ?? true,
      expectTrackingWorkItem: input.expectTrackingWorkItem ?? false,
      form,
      automationRules,
      trackingWorkItem,
      project,
      requestType,
      fields,
      workType,
      workflowScheme,
      automationAssociation,
      placeholders: placeholderValues,
    });

    const { data: _unredactedAutomation, ...automationInspection } = automationRules;

    return {
      identity: {
        spaceIdOrKey: input.spaceIdOrKey,
        spaceId: projectId,
        spaceKey: projectKey,
        serviceDeskId: input.serviceDeskId,
        requestTypeId: input.requestTypeId,
        requestTypeName: asString(asRecord(requestType.data)?.name),
        workTypeId,
      },
      readiness,
      links,
      pieces: {
        requestType,
        fields,
        requestTypeGroups: groups,
        form: { ...form, id: formId },
        workType,
        workflowScheme,
        automation: {
          ...automationInspection,
          association: automationAssociation,
          rules: redactSensitive(automationRules.data),
          candidatesRequireConfirmation: automationAssociation === "candidate",
          placeholderValues,
        },
        trackingWorkItem,
      },
      terminology: {
        public: { item: "work item", type: "work type", space: "space" },
        restAdapter: { item: "issue", type: "issueType", space: "project" },
      },
    };
  },
});

export const requestBuildTools = (): AnyToolDef[] => [inspectRequestBuild];

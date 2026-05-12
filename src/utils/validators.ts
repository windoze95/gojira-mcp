import { ValidationError } from "../middleware/errorHandler.js";

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const CLOUD_ID_RE = /^[0-9a-f-]{32,40}$/i;
const ACCOUNT_ID_SAFE_RE = /^[a-zA-Z0-9:_\-=]+$/;
const FIELD_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateIssueKey(key: string): string {
  if (!ISSUE_KEY_RE.test(key)) {
    throw new ValidationError(`Invalid Jira issue key: ${key}`);
  }
  return key;
}

export function validateProjectKey(key: string): string {
  if (!PROJECT_KEY_RE.test(key)) {
    throw new ValidationError(`Invalid Jira project key: ${key}`);
  }
  return key;
}

export function validateCloudId(id: string): string {
  if (!CLOUD_ID_RE.test(id)) {
    throw new ValidationError(`Invalid cloudId: ${id}`);
  }
  return id;
}

export function validateAccountId(id: string): string {
  // Atlassian account IDs are opaque; we only require they don't contain
  // hostile characters that could confuse url construction.
  if (typeof id !== "string" || id.length === 0 || !ACCOUNT_ID_SAFE_RE.test(id)) {
    throw new ValidationError(`Invalid accountId: ${id}`);
  }
  return id;
}

export function validateFieldId(id: string): string {
  if (!FIELD_ID_RE.test(id)) {
    throw new ValidationError(`Invalid field identifier: ${id}`);
  }
  return id;
}

/**
 * Server-managed fields that must never appear in an update payload.
 * Strip these before sending an issue update to Atlassian — they are either
 * computed by the server or governed by transitions and cannot be set directly.
 */
export const READONLY_ISSUE_FIELDS = new Set<string>([
  "id",
  "key",
  "self",
  "created",
  "updated",
  "creator",
  "status",
  "workratio",
  "lastViewed",
  "votes",
  "watches",
  "subtasks",
  "aggregateprogress",
  "progress",
  "issuetype",
]);

export function sanitizeIssueUpdate<T extends Record<string, unknown>>(payload: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (READONLY_ISSUE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out as T;
}

/**
 * JQL value escaping — escape quotes and backslashes so a user-supplied
 * literal can be safely embedded inside `"..."`.
 */
export function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Field name allowlist guard for ad-hoc JQL clause construction.
 * The intent: refuse anything other than a Jira field identifier.
 */
const JQL_FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
export function validateJqlField(field: string): string {
  if (!JQL_FIELD_RE.test(field)) {
    throw new ValidationError(`Invalid JQL field name: ${field}`);
  }
  return field;
}

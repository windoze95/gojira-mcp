/**
 * Canonical list of permission-group names — single source of truth for
 * both the runtime array (used to validate `GOJIRA_ENABLED_GROUPS` at
 * startup and to drive `gojira.listEnabledTools`) and the static
 * `PermissionGroup` union derived from it.
 *
 * Tool surface filtering is operator-controlled: deployments declare
 * `GOJIRA_ENABLED_GROUPS` (allowlist) plus `GOJIRA_ENABLE_ORG_ADMIN`.
 * The MCP bearer does not carry per-session scope filtering — current
 * MCP clients don't expose UI for custom OAuth scopes, so the bearer's
 * `scopes` array is informational rather than functional.
 */
export const ALL_PERMISSION_GROUPS = [
  "utility",
  "read_jsm_admin",
  "write_jsm_admin",
  "read_assets",
  "write_assets",
  "read_automation",
  "write_automation",
  "read_customfields",
  "write_customfields",
  "read_projects",
  "write_projects",
  "read_schemes",
  "write_schemes",
  "read_workflows",
  "write_workflows",
  "read_confluence_admin",
  "write_confluence_admin",
  "delete_projects",
  "read_agile",
  "write_agile",
  "read_filters_dashboards",
  "write_filters_dashboards",
  "admin_org",
] as const;

export type PermissionGroup = (typeof ALL_PERMISSION_GROUPS)[number];

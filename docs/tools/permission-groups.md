# Permission groups

A **permission group** is a tagged subset of tools that share a single
on/off switch *at deploy time*. Read and write are separate groups for
the same domain — an operator can disable write but keep read.

Each tool definition carries `group: <PermissionGroup>`. The deployment
declares its surface via `GOJIRA_ENABLED_GROUPS` — a comma-separated
allowlist of the groups this deployment registers. The env var is
required, has no implicit default, and is validated against the known
group names at startup. Least-privilege by default: nothing registers
unless it's named.

## The full list

| Group | Product | Tool count | Auth | Notes |
|---|---|---|---|---|
| `utility` | gojira itself | 7 | mixed | Always available when listed in the allowlist |
| `read_projects` | Jira | 3 | oauth | List/get project admin view + details |
| `write_projects` | Jira | 2 | oauth | Create + archive (delete is its own group) |
| `delete_projects` | Jira | 1 | oauth | **Isolated:** omitting this doesn't omit archive/restore |
| `read_schemes` | Jira | 13 | oauth | Permission/notification/workflow/screen/issue-type/field-config schemes — read |
| `write_schemes` | Jira | 7 | oauth | Create/update/delete schemes + project assignments |
| `read_workflows` | Jira | 6 | oauth | List/get workflows + transition components |
| `write_workflows` | Jira | 6 | oauth | Create/update/delete workflows, transitions, publish |
| `read_automation` | Jira | 4 | oauth | List automation rules, audit log, usage stats |
| `write_automation` | Jira | 5 | oauth | Create/update/delete/enable/disable rules |
| `read_customfields` | Jira | 3 | oauth | List/get fields and their contexts |
| `write_customfields` | Jira | 5 | oauth | Create/update/delete fields, assign contexts, set options |
| `read_filters_dashboards` | Jira | 4 | oauth | List/get filters and dashboards |
| `write_filters_dashboards` | Jira | 6 | oauth | Create/update/delete filters and dashboards |
| `read_agile` | Jira Software | 6 | oauth | Boards, sprints, epics — read |
| `write_agile` | Jira Software | 2 | oauth | Create/update sprints |
| `read_jsm_admin` | Jira Service Management | 18 | api_token | List/get for service desks, queues, SLAs, portals, etc. |
| `write_jsm_admin` | Jira Service Management | 15 | api_token | Create/update/delete for the same surface |
| `read_assets` | Assets (JSM add-on) | 11 | api_token | Read for Assets/Insight schemas, types, objects |
| `write_assets` | Assets (JSM add-on) | 12 | api_token | Mutate Assets data and schema |
| `read_confluence_admin` | Confluence | 6 | oauth | List/get spaces, templates, blueprints, restrictions |
| `write_confluence_admin` | Confluence | 4 | oauth | Create/update/delete spaces, set restrictions |
| `admin_org` | Atlassian Org (`admin.atlassian.com`) | 24 | org_admin | All org-admin ops — gated separately by `GOJIRA_ENABLE_ORG_ADMIN` |

## Why some groups are "isolated"

`delete_projects` is a separate permission group from `write_projects` so
that omitting deletion does **not** also drop archive/restore.

The use case: an operator wants the model to be able to create projects,
edit them, and archive them, but never delete them — even with
`commit:true`. With `delete_projects` isolated, just leave it out of
the allowlist:

```bash
GOJIRA_ENABLED_GROUPS=utility,read_projects,write_projects   # no delete_projects
```

`projects.deleteJiraProject` then fails to register; every other
`projects.*` tool stays available.

## Per-deployment recommendations

| Deployment shape | `GOJIRA_ENABLED_GROUPS` |
|---|---|
| Day-to-day admin (operators + automation) | `utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets,read_automation,write_automation,read_customfields,write_customfields,read_projects,write_projects,read_schemes,write_schemes,read_workflows,write_workflows,read_confluence_admin,write_confluence_admin,read_agile,write_agile,read_filters_dashboards,write_filters_dashboards` |
| Read-only audit | `utility,read_jsm_admin,read_assets,read_automation,read_customfields,read_projects,read_schemes,read_workflows,read_confluence_admin,read_agile,read_filters_dashboards` |
| JSM specialist | `utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets` |
| Org-admin (separate instance) | `utility,admin_org` (pair with `GOJIRA_ENABLE_ORG_ADMIN=true` and a separate audit channel) |
| Local development | same as Day-to-day admin |

## Bearer-scope future

The OAuth `scope` parameter at `/authorize` is intentionally **not**
extended with custom tokens today. Current MCP clients (Claude Desktop,
VS Code chat, Cursor, Claude Code) don't expose UI for picking custom
OAuth scopes; we don't ship a feature that depends on UX that doesn't
exist.

When clients add scope-picker support, the grammar can be extended with
`group:<name>` tokens that filter the registered surface per-session on
top of the operator allowlist. The change would be additive: existing
bearers and the allowlist continue working unchanged.

## Per-tool group lookup

The auto-generated [catalog](catalog.md) lists every tool with its
group explicitly. Use `gojira.listEnabledTools` at runtime to see
what's currently available to the caller.

## See also

- [Scope grammar](../oauth/scope-grammar.md) — the bearer-side phase
  grammar (no group tokens)
- [Tools overview](overview.md)
- [Adding a tool](../development/adding-a-tool.md) — picking the right
  group for a new tool
- [Environment variables](../deployment/environment-variables.md) — the
  `GOJIRA_ENABLED_GROUPS` row

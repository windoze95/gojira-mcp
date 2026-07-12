# OAuth scope handling

This page is short by design. gojira-mcp doesn't define a custom MCP-side
scope grammar — there's nothing to encode in the bearer beyond
`access`/`refresh` semantics that the SDK already handles.

## What's where

| Concept | Where it lives |
|---|---|
| **Atlassian OAuth scopes** (the upstream consent set: `read:jira-work`, `manage:jira-project`, `offline_access`, etc.) | `ATLASSIAN_OAUTH_SCOPES` env var. Requested upstream at every `/authorize`. Must include `offline_access` for refresh tokens. |
| **MCP bearer scopes** (the `scopes` array on the issued bearer) | Empty. The bearer is just "valid for this account_id." All authn carries through `extra.accountId`. |
| **Tool-surface filtering** | Server-side, via `GOJIRA_ENABLED_GROUPS` (operator allowlist) and `GOJIRA_ENABLE_ORG_ADMIN`. No bearer-side filtering. |

## Why not bearer-side filtering

Three earlier approaches were tried and removed:

1. **Phase scopes** (`phase:1` ... `phase:4`) — encoded "which sprint of
   tools shipped" into the bearer. Once all phases shipped, the
   distinction stopped meaning anything at runtime.
2. **Group scopes** (`group:read_jsm_admin`, etc.) — let the client pin
   the bearer to specific permission groups. Removed because no current
   MCP client (Claude Desktop, VS Code chat, Cursor, Claude Code)
   exposes UI for picking custom OAuth scopes; the surface was dead.
3. **Permission/admin scopes** in any other custom shape — same problem.

The remaining knobs are server-side and operator-controlled. If a future
MCP client adds scope-picker UI, custom scope tokens can be added back
without breaking changes.

## Atlassian OAuth scope listing

The deployment must register an OAuth app in the Atlassian developer
console with the **union** of every Atlassian scope it might need.
`ATLASSIAN_OAUTH_SCOPES` then names the subset to request at consent
time. Common scope sets:

```bash
# Daily admin (JSM, automation, custom fields, projects)
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account \
    read:jira-work write:jira-work \
    manage:jira-project manage:jira-configuration \
    read:servicedesk-request write:servicedesk-request \
    manage:servicedesk-customer

# Adds Confluence admin + workflow/scheme writes
ATLASSIAN_OAUTH_SCOPES=... \
    read:confluence-space.summary write:confluence-space \
    read:confluence-content.all write:confluence-content \
    manage:jira-webhook
```

Atlassian validates each scope at consent time; users see a consent
screen listing exactly what they're granting.

## Endpoints that need GRANULAR scopes (not classic)

Some tool groups call newer APIs that only honor Atlassian **granular** scopes.
Classic scopes return `401 "scope does not match"` on these. Add the granular
scopes alongside the classic ones where you enable the group:

- **Confluence space reads (v2)** — `confluence.listConfluenceSpaces`,
  `getConfluenceSpace`, `listSpacePermissions`, and the space update/delete
  before-snapshots hit `/wiki/api/v2/spaces*`. Add
  `read:space:confluence`, `read:space.permission:confluence`.
  (The v1 space *writes* still use classic `write:confluence-space`.)
- **Assets / CMDB** — every `assets.*` tool authenticates with the OAuth bearer
  against `api.atlassian.com/jsm/assets/...`. Add
  `read:cmdb-object:jira`, `write:cmdb-object:jira`,
  `read:cmdb-schema:jira`, `write:cmdb-schema:jira`.
- **Jira automation** — no OAuth scope exists for the automation public API
  (there is no Automation entry in the developer-console scope list), and none
  is needed: `read_automation`/`write_automation` bypass OAuth entirely and
  authenticate with the per-user API token (bound via `gojira.bindApiToken`)
  as **Basic auth** against
  `api.atlassian.com/automation/public/jira/<cloudId>/rest/v1`. The token's
  account must be a Jira administrator (ADMINISTER) — a non-admin token gets
  403 on every call, and a token created *before* the admin grant keeps its
  stale permissions, so create the token after granting admin. See
  [API token side-channel](api-token-side-channel.md).

These map to real API limits, not gojira config — see the header comments in
`src/tools/defs/confluence.ts`, `assets.ts`, and `automation.ts`.

## See also

- [Permission groups](../tools/permission-groups.md) — the operator-allowlist model
- [Auth flow](flow.md)
- [Environment variables](../deployment/environment-variables.md) — `ATLASSIAN_OAUTH_SCOPES`

# Tools overview

gojira-mcp exposes **153 tools** spread across **22 permission groups**
(plus an always-available `utility` group). Each tool is defined
declaratively via `defineTool` in `src/tools/defs/*.ts`.

## At a glance

| Doc | Theme | Tool count | Tool names start with |
|---|---|---|---|
| [Daily admin](daily-admin.md) | JSM, Assets, Automation, Custom fields, Projects (read/create/archive) | ~69 | `jsm.`, `forms.`, `assets.`, `automation.`, `customfields.`, `projects.` |
| [Schemes and workflows](schemes-and-workflows.md) | Schemes, workflow CRUD + publish, Confluence admin, project deletion | ~42 | `schemes.`, `workflows.`, `confluence.`, `projects.deleteJiraProject` |
| [Agile and views](agile-and-views.md) | Boards, sprints, epics, filters, dashboards | ~18 | `agile.`, `filters.`, `dashboards.` |
| [Org admin](org-admin.md) | `admin.atlassian.com` (gated separately) | 17 | `orgAdmin.` |
| [Utility](utility.md) (always available) | Health, identity, journal, side-channel binding | 7 | `gojira.` |

Counts are approximate; see the [catalog](catalog.md) for the exact
list.

## Tool naming convention

All tool names are dot-separated: `<group_prefix>.<operation>`.

| Prefix | Permission groups |
|---|---|
| `gojira.` | utility |
| `jsm.` | read_jsm_admin, write_jsm_admin |
| `assets.` | read_assets, write_assets |
| `automation.` | read_automation, write_automation |
| `customfields.` | read_customfields, write_customfields |
| `projects.` | read_projects, write_projects, delete_projects |
| `schemes.` | read_schemes, write_schemes |
| `workflows.` | read_workflows, write_workflows |
| `confluence.` | read_confluence_admin, write_confluence_admin |
| `agile.` | read_agile, write_agile |
| `filters.` | read_filters_dashboards, write_filters_dashboards (filter tools) |
| `dashboards.` | read_filters_dashboards, write_filters_dashboards (dashboard tools) |
| `orgAdmin.` | admin_org |

Dot notation works in all major MCP clients (Claude Desktop, VS Code chat,
Cursor, Claude Code) and naturally clusters tools in client UIs that
display flat lists.

## Per-tool metadata

Every tool definition carries:

```ts
interface ToolDefinition {
  name: string;                       // dot-prefixed, e.g. "customfields.createCustomField"
  description: string;                // surfaces in client UIs
  group: PermissionGroup;             // e.g. "write_customfields"
  authMethod: "oauth" | "api_token" | "oauth_or_api_token" | "org_admin" | "none";
  destructive: boolean;               // true → commit-positive consent enforced
  needsCloudId: boolean;              // true → resolveCloudId applied
  inputSchema: ZodObject;             // converted to JSON schema for the MCP client
  handler: (input, ctx) => Promise<unknown>;
}
```

Inspect any tool's metadata via:

```bash
# locally
npm run docs:tools && cat docs/tools/catalog.md

# at runtime
# (call gojira.listEnabledTools through your MCP client)
```

## Filtering

The set of tools registered to a session is filtered two ways:

1. **Operator allowlist** — `GOJIRA_ENABLED_GROUPS` (server-side, deploy time)
2. **Org-admin gate** — `GOJIRA_ENABLE_ORG_ADMIN` (server-side, deploy time)

A tool survives to be registered iff it passes both.

The filter logic lives in `filterTools` in `src/tools/registry.ts`:

```ts
return defs.filter((d) => {
  if (!enabled.has(d.group)) return false;          // operator allowlist
  if (d.group === "admin_org" && !orgAdminEnabled) return false;
  return true;
});
```

Defense in depth: the dispatch wrapper inside `wrapHandler` re-checks
the allowlist before each tool call, so a leaked tool can't actually
fire.

## Adding a tool

See [adding-a-tool.md](../development/adding-a-tool.md) for the recipe:

1. Pick the permission group → import file under `src/tools/defs/`
2. Call `defineTool({ name, group, authMethod, destructive,
   needsCloudId, input, handler })`
3. For destructive ops: snapshot `before`, build a dry-run, wrap in
   `ctx.journalOp`
4. For revertible ops: register a reverter at the bottom of the file
5. Add to `tests/` if it carries a complex code path (most simple
   pass-throughs don't need a dedicated test)
6. `npm run docs:tools` to refresh the catalog

## Practical surface size

The complete tool set (153) is too large for any single frontier model
to dispatch with maximum accuracy. To keep model behaviour sharp:

- **Tighten the allowlist:** set `GOJIRA_ENABLED_GROUPS` to exactly the
  groups this deployment needs. For a read-only audit deployment, list
  only `utility` + the `read_*` groups — model only sees ~81 tools.
- **One deployment per use-case:** rather than running one big instance
  with everything enabled, run a JSM-only instance, a workflow-admin
  instance, etc. Smaller surface = sharper tool selection.
- **Use `gojira.listEnabledTools`** at runtime to verify the surface
  matches what the use case needs.

## See also

- [Permission groups](permission-groups.md)
- [Utility tools](utility.md)
- [Daily admin](daily-admin.md), [Schemes and workflows](schemes-and-workflows.md), [Agile and views](agile-and-views.md), [Org admin](org-admin.md)
- [Full auto-generated catalog](catalog.md)
- [Adding a tool](../development/adding-a-tool.md)

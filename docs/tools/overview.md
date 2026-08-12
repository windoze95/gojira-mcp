# Tools overview

gojira-mcp exposes **65 tools carrying 162 operations**,
spread across **25 permission groups** (including `utility`, which every
deployment should list explicitly — nothing auto-injects it). Most tools
bundle 2-7 related operations behind a required `op` enum field (built via
`defineOpTool`); single-purpose tools use plain `defineTool`. Definitions
live in `src/tools/defs/*.ts`.

## At a glance

| Doc | Theme | Tools (operations) | Tool names start with |
|---|---|---|---|
| [Daily admin](daily-admin.md) | JSM, Forms, work items, Assets, Automation, Custom fields, Projects (read/create/archive) | 29 (78 ops) | `jsm.`, `forms.`, `workitems.`, `assets.`, `automation.`, `customfields.`, `projects.` |
| [Schemes and workflows](schemes-and-workflows.md) | Schemes, workflows + publish, Confluence admin, project deletion | 15 (~42 ops) | `schemes.`, `workflows.`, `confluence.`, `projects.delete` |
| [Agile and views](agile-and-views.md) | Boards, sprints, epics, filters, dashboards | 8 (18 ops) | `agile.`, `filters.`, `dashboards.` |
| [Org admin](org-admin.md) | `admin.atlassian.com` (gated separately) | 6 (17 ops) | `orgAdmin.` |
| [Utility](utility.md) | Health, identity, journal, side-channel binding | 6 (7 ops) | `gojira.` |

See the [catalog](catalog.md) for the exact per-op listing.

## Tool naming convention

Tool names are dot-separated `<module>.<verb>` following the collapse's
read/manage/delete pattern: `.read*` tools are pure reads, `.manage*`
tools mutate (commit-positive consent), `.delete*` tools carry the
delete-class operations — always their own tool, never folded into
manage, so a profile can exclude deletion at registration time. A few
keepers retain their pre-collapse names (`assets.aqlSearch`,
`gojira.bindApiToken`, `workflows.validateCreateWorkflow`, ...). The
operation WITHIN a tool is selected by its required `op` field; op values
are the pre-collapse leaf verbs (`createObjectSchema`, `listQueues`, ...),
and the [catalog appendix](catalog.md#legacy-name-map-pre-collapse--current)
maps every pre-collapse tool name to its current tool + op.

| Prefix | Permission groups |
|---|---|
| `gojira.` | utility |
| `jsm.` | read_jsm_admin, write_jsm_admin |
| `workitems.` | read_workitems, write_workitems |
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
  name: string;                       // dot-prefixed, e.g. "customfields.manage"
  description: string;                // prose that ENUMERATES the ops — the model's selection index
  group: PermissionGroup;             // e.g. "write_customfields"
  authMethod: "oauth" | "api_token" | "oauth_or_api_token" | "org_admin" | "none";
  destructive: boolean;               // true → commit-positive consent enforced (all ops)
  needsCloudId: boolean;              // true → resolveCloudId applied
  readOnly?: boolean;                 // explicit read-only marker — annotations are purely flag-driven
  ops?: OpManifestEntry[];            // op manifest (op tools only): per-op description,
                                      //   destructive, legacyName, input shape, revertibility claim
  inputSchema: ZodObject;             // flat merge: required `op` enum + per-op fields (optional),
                                      //   strictly re-validated per op at dispatch
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

## Adding an operation or tool

See [adding-a-tool.md](../development/adding-a-tool.md) for the full
recipe. In short: extend an existing collapsed tool with a `defineOp`
spec (op name, one-line description, real-required-ness input shape,
per-op `revert` where applicable) when the operation fits its family and
the tool stays within the 5-7 op cap; create a new tool (read/manage/
delete pattern) otherwise. `npm run docs:tools` refreshes the catalog —
CI fails if it drifts — and `tests/tools/opRevertCoverage.test.ts`
enforces manifest-driven revert coverage.

## Practical surface size

The collapsed catalog plus focused work-item primitives put every deployment shape
under the tool-count thresholds where model selection degrades, and the
split-surface fleet keeps every *connected* surface under ~30:

- **Tighten the allowlist:** set `GOJIRA_ENABLED_GROUPS` to exactly the
  groups this deployment needs. A read-only audit deployment (`utility`
  + the `read_*` groups) advertises 29 tools.
- **One deployment per use-case:** the split-surface fleet
  ([README Pattern 8](../../README.md#pattern-8--split-surface-fleet--29302119-12-tools),
  [profiles guide](../deployment/profiles.md)) runs one instance per
  workflow batch — 29/30/21/19/12 tools per profile.
- **Use `gojira.listEnabledTools`** at runtime (with
  `available_only: true` for just this instance's surface) to verify the
  surface matches the use case; each tool row lists its `ops`.

## See also

- [Permission groups](permission-groups.md)
- [Utility tools](utility.md)
- [Daily admin](daily-admin.md), [Schemes and workflows](schemes-and-workflows.md), [Agile and views](agile-and-views.md), [Org admin](org-admin.md)
- [Full auto-generated catalog](catalog.md)
- [Adding a tool](../development/adding-a-tool.md)

# Schemes, workflows, Confluence admin

The configuration surface above individual issues:
permission/notification/workflow/screen/issue-type/field-configuration
schemes, workflow CRUD with async publish, Confluence space administration,
and the isolated `delete_projects` group.

42 tools across 7 permission groups.

## Schemes (`read_schemes` / `write_schemes`)

**Credential:** OAuth.

### Permission schemes
- `schemes.listPermissionSchemes()` — no pagination; returns the full list.
- `schemes.getPermissionScheme(schemeId, expand[]?)`.
- `schemes.createPermissionScheme(name, description?, permissions[]?, commit)` — destructive, revertible.
- `schemes.updatePermissionScheme(schemeId, name?, description?, permissions[]?, commit)` — destructive, revertible. PUT-replace semantics.
- `schemes.deletePermissionScheme(schemeId, commit)` — destructive, irreversible.
- `schemes.assignPermissionSchemeToProject(projectKeyOrId, schemeId, commit)` — destructive, **revertible** (restores prior scheme).

### Notification schemes
- `schemes.listNotificationSchemes(startAt?, maxResults?)`.
- `schemes.getNotificationScheme(schemeId, expand[]?)`.
- `schemes.createNotificationScheme(name, description?, notificationSchemeEvents[]?, commit)` — destructive, revertible.
- `schemes.updateNotificationScheme(schemeId, name?, description?, commit)` — destructive, revertible.
- `schemes.deleteNotificationScheme(schemeId, commit)` — destructive, irreversible.

### Workflow schemes (read-only here)
- `schemes.listWorkflowSchemes(startAt?, maxResults?)`.
- `schemes.getWorkflowScheme(schemeId)`.

### Screens & screen schemes (read-only here)
- `schemes.listScreens(startAt?, maxResults?)`.
- `schemes.getScreen(screenId)`.
- `schemes.listScreenSchemes(startAt?, maxResults?)`.

### Issue-type schemes (read-only here)
- `schemes.listIssueTypeSchemes(startAt?, maxResults?)`.
- `schemes.getIssueTypeScheme(schemeId)`.

### Field configurations (read-only here)
- `schemes.listFieldConfigurations(startAt?, maxResults?)`.
- `schemes.getFieldConfiguration(configId)`.

## Workflows (`read_workflows` / `write_workflows`)

**Credential:** OAuth.

- `workflows.listWorkflows(startAt?, maxResults?, queryString?)` — `queryString` is a case-insensitive substring match on the workflow name. Each result includes its statuses and transitions inline.
- `workflows.getWorkflow(workflowId)` — `workflowId` is a workflow **name or entity id**.
- `workflows.getWorkflowTransitions(workflowId)`.
- `workflows.getWorkflowConditions(workflowId, transitionId)`.
- `workflows.getWorkflowValidators(workflowId, transitionId)`.
- `workflows.getWorkflowPostFunctions(workflowId, transitionId)`.
- `workflows.validateCreateWorkflow(payload)` — dry-run validation, no changes. Body shape matches `createWorkflow.payload`.
- `workflows.createWorkflow(payload, commit)` — destructive, revertible.
- `workflows.updateWorkflow(payload, commit)` — destructive, **not auto-revertible** (see below).
- `workflows.deleteWorkflow(workflowId, commit)` — destructive, irreversible. The workflow must not be in use by any scheme.
- `workflows.publishWorkflowSchemeDraft(schemeId, statusMappings[]?, commit)` — destructive, **async with poll**.

The condition/validator/post-function getters are conveniences, not
separate endpoints: the current API carries those rules inline on each
transition, so these tools read the workflow and project the requested
rule field off the matching transition.

### There is no per-transition endpoint

Jira Cloud has **no** REST endpoint for adding or removing a single
transition. Transition, condition, validator and post-function changes
all go through the bulk update API, i.e. `workflows.updateWorkflow`,
whose `payload` is the `POST /workflows/update` body:

```json
{
  "statuses": [],
  "workflows": [{ "id": "<entity-id>", "statuses": [], "transitions": [] }]
}
```

Read the workflow first (`workflows.getWorkflow`), edit the returned
definition, and send the whole thing back.

`workflows.updateWorkflow` journals `revertible: false`. It *does*
capture the full before-state of every targeted workflow, and its
revert hint says so — but reverting is a manual re-apply of that
captured `before` through `updateWorkflow`, not a `gojira.revertOperation`
one-liner.

### About `publishWorkflowSchemeDraft`

Workflow changes go live in Jira Cloud by publishing a workflow
**scheme's** draft — there is no per-workflow publish. Hence `schemeId`
(a workflow scheme id, from `GET /rest/api/3/workflowscheme`), not a
workflow id.

The publish is asynchronous: Jira returns a task id and runs the publish
in the background. gojira-mcp polls `/rest/api/3/task/{taskId}` up to 15
times with a backoff (1.5 s growing to a 5 s cap, ~60 s of budget). A
result whose status is `COMPLETE`, `FAILED`, `CANCELLED` or `DEAD` is
final. If the budget runs out first, the tool returns:

```json
{
  "status": "RUNNING",
  "taskId": "...",
  "note": "Publish still in progress; poll GET /rest/api/3/task/<id> until it is COMPLETE."
}
```

A `RUNNING` result means the publish is **not** done. The caller MUST
verify completion itself.

`statusMappings[]` describes how in-flight issues should be re-statused
across the publish. Test changes in a sandbox first.

## Confluence admin (`read_confluence_admin` / `write_confluence_admin`)

**Credential:** API token (Basic), **not** OAuth. Every `confluence.*`
tool is `authMethod: "api_token"` and goes to the site host under
`/wiki`. OAuth is not an option here — the 3LO path 410s on the v1 space
API, which is why the API-token client is the only one wired up. Bind a
token with `gojira.bindApiToken` first.

### Spaces
- `confluence.listConfluenceSpaces(cursor?, limit?, type?, status?)` — `type` is `global|personal`, `status` is `current|archived`.
- `confluence.getConfluenceSpace(spaceId)`.
- `confluence.createConfluenceSpace(key, name, description?, commit)` — destructive, revertible.
- `confluence.updateConfluenceSpace(spaceKey, name?, description?, commit)` — destructive, revertible.
- `confluence.deleteConfluenceSpace(spaceKey, commit)` — destructive, **irreversible** (recover from Confluence-side trash if within retention window).

Note the asymmetry: `getConfluenceSpace` takes a numeric **spaceId**,
while the update/delete tools take a **spaceKey**.

### Permissions, templates, blueprints
- `confluence.listSpacePermissions(spaceId)`.
- `confluence.listTemplates(spaceKey?, startAt?, maxResults?)`.
- `confluence.listBlueprints(spaceKey?)`.

### Content restrictions
- `confluence.getContentRestrictions(contentId)`.
- `confluence.setContentRestrictions(contentId, restrictions[], commit)` — destructive, revertible. Replaces the restriction set.

`setContentRestrictions` requires a **paid** Confluence plan. On
Confluence Free it 403s on the write while reads keep working — that is
a licensing limit, not a bug.

## Delete projects (`delete_projects` — isolated)

**Credential:** OAuth. Separate permission group so revoking deletion
doesn't disable archive/restore in `write_projects`.

- `projects.deleteJiraProject(project, enableUndo?, commit)` — destructive, **revertible iff `enableUndo:true`**.

### `enableUndo`

Atlassian supports a 60-day trash for projects:

- `enableUndo: false` (default) — **permanent delete**, no programmatic
  undo. Restore from your own backup if available.
- `enableUndo: true` — moves the project to trash, recoverable for 60
  days via `POST /rest/api/3/project/<key>/restore`. The journal entry
  is marked `revertible: true`.

The dry-run output communicates which behaviour will apply when
`commit: true`:

> *"Would TRASH the project (60-day undo window). Re-invoke with commit:true to apply."*
> or
> *"Would PERMANENTLY DELETE the project. Re-invoke with commit:true to apply. NO UNDO."*

## See also

- [Daily admin](daily-admin.md), [Agile and views](agile-and-views.md), [Org admin](org-admin.md)
- [Commit-positive consent](../architecture/commit-positive-consent.md) —
  every destructive tool here requires `commit: true`
- [Operation journal](../architecture/operation-journal.md) — what gets
  captured for each mutation
- [Full catalog with input schemas](catalog.md)

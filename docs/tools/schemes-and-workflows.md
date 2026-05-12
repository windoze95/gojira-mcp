# Schemes, workflows, Confluence admin

The configuration surface above individual issues:
permission/notification/workflow/screen/issue-type/field-configuration
schemes, workflow CRUD with async publish, Confluence space administration,
and the isolated `delete_projects` group.

Roughly 43 tools across 8 permission groups.

## Schemes (`read_schemes` / `write_schemes`)

**Credential:** OAuth.

### Permission schemes
- `schemes.listPermissionSchemes`.
- `schemes.getPermissionScheme(schemeId, expand[]?)`.
- `schemes.createPermissionScheme(name, description?, permissions[]?)` — destructive, revertible.
- `schemes.updatePermissionScheme(schemeId, name?, description?, permissions[]?)` — destructive, revertible.
- `schemes.deletePermissionScheme(schemeId)` — destructive, irreversible.
- `schemes.assignPermissionSchemeToProject(projectKeyOrId, schemeId)` — destructive, **revertible** (restores prior scheme).

### Notification schemes
- `schemes.listNotificationSchemes(startAt?, maxResults?)`.
- `schemes.getNotificationScheme(schemeId, expand[]?)`.
- `schemes.createNotificationScheme(name, description?, notificationSchemeEvents[]?)` — destructive, revertible.
- `schemes.updateNotificationScheme(schemeId, name?, description?)` — destructive, revertible.
- `schemes.deleteNotificationScheme(schemeId)` — destructive, irreversible.

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

- `workflows.listWorkflows(startAt?, maxResults?, workflowName?)`.
- `workflows.getWorkflow(workflowId)`.
- `workflows.createWorkflow(name, description?, statuses[]?, transitions[]?)` — destructive, revertible.
- `workflows.updateWorkflow(workflowId, body)` — destructive, revertible (full-before/full-after diff).
- `workflows.deleteWorkflow(workflowId)` — destructive, irreversible.
- `workflows.getWorkflowTransitions(workflowId)`.
- `workflows.addWorkflowTransition(workflowId, transition)` — destructive.
- `workflows.removeWorkflowTransition(workflowId, transitionId)` — destructive.
- `workflows.getWorkflowConditions(workflowId, transitionId)`.
- `workflows.getWorkflowPostFunctions(workflowId, transitionId)`.
- `workflows.getWorkflowValidators(workflowId, transitionId)`.
- `workflows.publishWorkflow(workflowId, statusMappings[]?)` — destructive, **async with poll**.

### About `publishWorkflow`

Atlassian's publish endpoint is asynchronous; it returns a `taskId` and
the actual publish runs in the background. gojira-mcp polls
`/rest/api/3/task/{taskId}` every 1.5 s for up to 10 attempts (~15 s
wall clock). If the publish completes within that window, the tool
returns the final task status. Otherwise it returns:

```json
{
  "status": "RUNNING",
  "taskId": "...",
  "note": "Publish still in progress; check /task/{id} for completion."
}
```

The caller can poll the task themselves or re-fetch the workflow status
to see whether the publish landed.

`statusMappings[]` describes how in-flight issues should be re-statused
across the publish. Test changes in a sandbox first.

## Confluence admin (`read_confluence_admin` / `write_confluence_admin`)

**Credential:** OAuth.

### Spaces
- `confluence.listConfluenceSpaces(cursor?, limit?, type?, status?)`.
- `confluence.getConfluenceSpace(spaceId)`.
- `confluence.createConfluenceSpace(key, name, description?)` — destructive, revertible.
- `confluence.updateConfluenceSpace(spaceKey, name?, description?)` — destructive, revertible.
- `confluence.deleteConfluenceSpace(spaceKey)` — destructive, **irreversible** (recover from Confluence-side trash if within retention window).

### Permissions, templates, blueprints
- `confluence.listSpacePermissions(spaceId)`.
- `confluence.listTemplates(spaceKey?, startAt?, maxResults?)`.
- `confluence.listBlueprints(spaceKey?)`.

### Content restrictions
- `confluence.getContentRestrictions(contentId)`.
- `confluence.setContentRestrictions(contentId, restrictions[])` — destructive, revertible.

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

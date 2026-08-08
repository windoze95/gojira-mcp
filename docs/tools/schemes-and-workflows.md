# Schemes, workflows, Confluence admin

The configuration surface above individual issues:
permission/notification/workflow/screen/issue-type/field-configuration
schemes, workflow CRUD with async publish, Confluence space administration,
and the isolated `delete_projects` group.

16 tools carrying 42 operations across 7 permission groups. Most are
op-parameterized — one tool, several operations selected by a required
`op` field, called as `{ "op": "…", …args }`. The auto-generated
[catalog](catalog.md) has every input schema.

Fields listed as *Required* below are enforced for that op at dispatch;
passing a sibling op's field is an error that names the op the field
belongs to. A destructive op tool carries one `commit` flag shared by all
its ops. Several tools here share a field *name* across ops that mean
different things by it — `schemeId` addresses two id spaces in
`schemes.readAccess` — and those cases are called out below and in the
catalog's field descriptions. The pre-collapse names
(`schemes.listPermissionSchemes`, `workflows.createWorkflow`, …) still
resolve for journal and revert purposes; the mapping is at the bottom of
the catalog.

## Schemes (`read_schemes` / `write_schemes`)

**Credential:** OAuth. Reads use the `/rest/api/3` paginated endpoints.

### `schemes.readAccess` — 4 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listPermissionSchemes` | — | No pagination; returns the full list |
| `getPermissionScheme` | `schemeId` | `expand: ["all"]` for the full grant list |
| `listNotificationSchemes` | — | Paginated (`startAt`, `maxResults`) |
| `getNotificationScheme` | `schemeId` | `expand` supported |

`schemeId` here is a **permission** scheme id for the permission ops and
a **notification** scheme id for the notification ops. The two id spaces
do not overlap and Jira will not tell you which one you meant — it 404s.

### `schemes.readScreen` — 3 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listScreens` | — | Paginated |
| `getScreen` | `screenId` | |
| `listScreenSchemes` | — | Paginated |

There is no `GET /screens/{id}` — that path is PUT/DELETE only. `getScreen`
therefore filters the list endpoint with `?id=`, and answers with the
list envelope rather than a bare screen object.

### `schemes.readConfig` — 6 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listWorkflowSchemes` | — | Paginated |
| `getWorkflowScheme` | `schemeId` | Workflow scheme id |
| `listIssueTypeSchemes` | — | Paginated |
| `getIssueTypeScheme` | `schemeId` | Issue-type scheme id; served via `?id=` |
| `listFieldConfigurations` | — | Paginated |
| `getFieldConfiguration` | `configId` | Served via `?id=` |

Same shared-name caveat as `readAccess`: `schemeId` is a *workflow*
scheme id for `getWorkflowScheme` and an *issue-type* scheme id for
`getIssueTypeScheme`. And as with screens, the issue-type-scheme and
field-configuration getters filter a list endpoint rather than fetching
a single resource, so they return the list envelope.

Workflow schemes are read-only here. The one write against a workflow
scheme in this surface is publishing its draft —
`workflows.manage` op `publishWorkflowSchemeDraft`, below.

### `schemes.managePermission` — 3 ops, destructive, all revertible

| op | Required | Revert |
|---|---|---|
| `createPermissionScheme` | `name` | Deletes the created scheme |
| `updatePermissionScheme` | `schemeId` | PUTs the captured `before` back |
| `assignPermissionSchemeToProject` | `projectKeyOrId`, `schemeId` | Restores the prior assignment |

`permissions[]` has **PUT-replace semantics**: the array you send becomes
the entire grant list. Read the current grants first with
`schemes.readAccess getPermissionScheme(expand: ["all"])` and send the
whole edited list back.

`PUT /permissionscheme/{id}` also *requires* `name`. A description-only or
permissions-only update would 400 on its own, so `updatePermissionScheme`
reads the scheme (with `?expand=all`) and carries the existing name
forward. That same expanded read is what lands in the journal as
`before`, which is why reverting an update restores the full grant list
and not just the scalar fields.

### `schemes.manageNotification` — 2 ops, destructive, both revertible

| op | Required | Revert |
|---|---|---|
| `createNotificationScheme` | `name` | Deletes the created scheme |
| `updateNotificationScheme` | `schemeId` | PUTs the captured `before` back |

`notificationSchemeEvents` — the event → recipient mappings — can only be
set at **create**. There is no update path for them, so getting the event
list wrong means creating a replacement scheme, not patching this one.

The update revert always sends `description`, falling back to `""`.
`PUT /notificationscheme/{id}` is a *partial* update and Jira omits
`description` entirely from the GET when a scheme has none, so omitting
it on revert would leave a description the update added in place — a
silently half-successful revert.

### `schemes.delete` — 2 ops, destructive, irreversible

| op | Required |
|---|---|
| `deletePermissionScheme` | `schemeId` |
| `deleteNotificationScheme` | `schemeId` |

`schemeId` is again whichever id space the op names. Both capture a full
before-snapshot into the journal (the permission scheme with
`?expand=all`), but journal `revertible: false`: the snapshot exists for
the audit trail and for a manual re-create, not for
`gojira.revertOperation`.

## Workflows (`read_workflows` / `write_workflows`)

**Credential:** OAuth.

Atlassian replaced the old `/rest/api/3/workflow*` endpoints with an
async bulk API. Everything below targets that API:

```
GET    /rest/api/3/workflows/search   list/search (transitions + statuses inline)
POST   /rest/api/3/workflows          bulk read by name or id
POST   /rest/api/3/workflows/create   create
POST   /rest/api/3/workflows/update   update
DELETE /rest/api/3/workflow/{entityId}
```

### `workflows.read` — 6 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listWorkflows` | — | `queryString`, `expand: usage \| values.transitions` |
| `getWorkflow` | `workflowId` | Name **or** entity id |
| `getWorkflowTransitions` | `workflowId` | |
| `getWorkflowConditions` | `workflowId`, `transitionId` | |
| `getWorkflowValidators` | `workflowId`, `transitionId` | |
| `getWorkflowPostFunctions` | `workflowId`, `transitionId` | Returned under the API's `actions` key |

`queryString` is a case-insensitive substring match on the workflow name,
and each `listWorkflows` result already includes its statuses and
transitions inline.

The condition/validator/post-function ops are conveniences, not separate
endpoints: the current API carries those rules inline on each transition,
so these ops read the workflow and project the requested rule field off
the matching transition.

Two behaviours worth relying on:

- **Name-or-id lookup.** The bulk read rejects `workflowNames` and
  `workflowIds` in the same request, so `getWorkflow` tries the key as a
  name first and falls back to treating it as an entity id. An unmatched
  key answers 404 upstream, which is treated as a miss rather than a
  failure.
- **Misses are explicit.** A workflow that doesn't exist returns
  `{ found: false, workflowId }`, and a transition that doesn't exist
  returns `{ found: false, workflowId, transitionId }` — a missing
  workflow is never reported as a workflow with zero transitions.

### `workflows.manage` — 3 ops, destructive

| op | Required | Revertible |
|---|---|---|
| `createWorkflow` | `payload` | yes — deletes the created workflow(s) |
| `updateWorkflow` | `payload` | no — see below |
| `publishWorkflowSchemeDraft` | `schemeId` | no |

`payload` is one advertised field carrying **two different body shapes**.
The merged tool schema can only advertise it loosely (an object), so each
op validates the real shape at dispatch and rejects the wrong one by
name:

- `createWorkflow` — the `POST /workflows/create` body:
  `{ scope: { type: "GLOBAL" | "PROJECT", project? }, statuses: [{ statusReference, name, statusCategory }], workflows: [{ name, description?, statuses, transitions }] }`.
  Validate it first with `workflows.validateCreateWorkflow` if unsure.
- `updateWorkflow` — the `POST /workflows/update` body:
  `{ statuses: [...], workflows: [{ id, statuses, transitions, ... }] }`.

#### There is no per-transition endpoint

Jira Cloud has **no** REST endpoint for adding or removing a single
transition. Transition, condition, validator and post-function changes
all go through the bulk update API, i.e. `updateWorkflow`:

```json
{
  "statuses": [],
  "workflows": [{ "id": "<entity-id>", "statuses": [], "transitions": [] }]
}
```

Read the workflow first (`workflows.read getWorkflow`), edit the returned
definition, and send the whole thing back.

`updateWorkflow` journals `revertible: false`. It *does* capture the full
before-state of every targeted workflow — one snapshot per entity id —
and its revert hint says so, but reverting is a manual re-apply of that
captured `before` through `updateWorkflow`, not a
`gojira.revertOperation` one-liner.

`createWorkflow` is revertible: the created entity ids are derived from
the response onto the journal target (comma-joined when the payload
created several), and the reverter deletes each of them.

#### About `publishWorkflowSchemeDraft`

Workflow changes go live in Jira Cloud by publishing a workflow
**scheme's** draft — there is no per-workflow publish. Hence `schemeId`
(a workflow scheme id, from `schemes.readConfig listWorkflowSchemes`),
not a workflow id.

The publish is asynchronous. Jira answers `303 See Other` with an empty
body and a `Location` pointing at the async task; the HTTP client follows
that same-host redirect, so what comes back is the task resource itself,
keyed **`id`** — the API never returns a `taskId` field. gojira-mcp then
polls `/rest/api/3/task/{id}` up to 15 times on a backoff (1.5 s growing
to a 5 s cap, ~60 s of budget). A result whose status is `COMPLETE`,
`FAILED`, `CANCELLED` or `DEAD` is final. If the budget runs out first,
the op returns:

```json
{
  "status": "RUNNING",
  "taskId": "...",
  "note": "Publish still in progress; poll GET /rest/api/3/task/<id> until it is COMPLETE."
}
```

A `RUNNING` result means the publish is **not** done. The caller MUST
verify completion itself. (If no task id comes back at all, the result is
`status: "SUBMITTED"` with a note to verify the scheme in Jira — same
obligation.)

`statusMappings[]` describes how in-flight issues should be re-statused
across the publish. A scheme switch routinely runs 30 s or more. Test
changes in a sandbox first.

### `workflows.delete` — single-op, destructive, irreversible

`workflows.delete(workflowId, commit)`. `workflowId` is a name or entity
id; the op resolves it through the same bulk read as `getWorkflow` and
deletes by entity id. The workflow must not be in use by any scheme.

The dry run refuses to preview a delete of something that isn't there: a
name that resolves to nothing returns `{ found: false, workflowId }`
rather than a perfectly ordinary-looking delete plan for a typo.

### `workflows.validateCreateWorkflow` — single-op, read-only

Dry-run validation for a create-workflow payload; changes nothing. Body
shape matches `workflows.manage createWorkflow`'s `payload`.

It stayed a separate tool deliberately. Folding a non-destructive op into
the destructive `workflows.manage` would flip that tool's annotations,
attach the confirm card to a validation result, and force a `commit` this
operation should never need.

## Confluence admin (`read_confluence_admin` / `write_confluence_admin`)

**Credential:** API token (Basic), **not** OAuth. Every `confluence.*`
tool is `authMethod: "api_token"` and goes to the site host under
`/wiki`. Bind a token with `gojira.bindApiToken` first.

OAuth is not an option here, verified live against the dev tenant: on the
OAuth host (`api.atlassian.com/ex/confluence/{cloudId}`) the v2 space
reads 401 unless the app declares GRANULAR scopes, and the v1 space API —
which the space writes, templates and restrictions all depend on —
returns **410 Gone** outright. The site host accepts the bound API token
via Basic auth for *both* v1 and v2, with no OAuth scopes involved.

The v1/v2 split leaks into the tool vocabulary: **reads address a space
by its numeric v2 `spaceId`, writes address it by `spaceKey`.** That
asymmetry is upstream's, not ours.

### `confluence.readSpace` — 3 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listConfluenceSpaces` | — | Cursor-paged v2; `type` (`global`/`personal`), `status` (`current`/`archived`), `limit` ≤ 250 |
| `getConfluenceSpace` | `spaceId` | Numeric **v2** space id |
| `listSpacePermissions` | `spaceId` | Numeric v2 space id |

Paging here is cursor-based (`cursor` from the previous page), not
`startAt`/`maxResults` like the Jira reads.

### `confluence.readContent` — 3 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listTemplates` | — | Optional `spaceKey`; `startAt`/`maxResults` map onto v1's `start`/`limit` |
| `listBlueprints` | — | Optional `spaceKey` |
| `getContentRestrictions` | `contentId` | |

### `confluence.manageSpace` — 2 ops, destructive, both revertible

| op | Required | Revert |
|---|---|---|
| `createConfluenceSpace` | `spaceKey`, `name` | Deletes the created space |
| `updateConfluenceSpace` | `spaceKey` | PUTs the captured `before` back |

Both take an optional plain-text `description`, and both are keyed by
`spaceKey`. The pre-collapse create tool called that field `key`; it maps
onto the v1 API's `key` body field, and the space key rides on
`target.key` in journal entries from both eras, so pre-collapse creates
stay revertible.

Two API facts hold this together:

- **The v1 space GET was removed** (410), so before-snapshots come from
  v2 — with `description-format=plain`. That parameter is not optional:
  without it v2 omits `description` entirely, and a snapshot with no
  description cannot restore one.
- **The revert rebuilds a v1 body from a v2 snapshot.** v2 nests the
  description under `description.plain.value`; v1 wants a full
  `{ plain: { value, representation } }`. The v1 PUT is a partial update,
  so `description` is always sent (defaulting to `""`) — omitting it
  would leave a newly added description in place instead of clearing it.

### `confluence.delete` — single-op, destructive, irreversible

`confluence.delete(spaceKey, commit)`. Recover from Confluence's own
trash if you are still inside the retention window; there is no
programmatic undo here.

### `confluence.setContentRestrictions` — single-op, destructive, revertible

Replaces the restriction set on one piece of content
(`contentId`, `restrictions[]`, `commit`).

It stayed its own tool because its `restrictions` blob shares no input
shape with the space ops, and its revert has a branch none of them need:
`before.results` is PUT back as the restriction list, *unless* it is
empty — content that carried no restrictions at all is restored with a
DELETE, because a PUT of nothing is not the way back.

`setContentRestrictions` requires a **paid** Confluence plan. On
Confluence Free it 403s on the write while reads keep working — that is
a licensing limit, not a bug.

## Delete projects (`delete_projects` — isolated)

**Credential:** OAuth. Separate permission group so revoking deletion
doesn't disable archive/restore in `write_projects`.

`projects.delete(project, permanent?, commit)` — single-op, destructive,
**revertible unless `permanent: true`**. (Renamed from
`projects.deleteJiraProject`; the old name still resolves for pre-rename
journal entries.)

### `permanent`

Atlassian supports a 60-day trash for projects, and the tool defaults to
using it:

- `permanent: false` (**default**) — moves the project to trash,
  recoverable for ~60 days via
  `POST /rest/api/3/project/<key>/restore`. The journal entry is marked
  `revertible: true`.
- `permanent: true` — **permanent hard delete**, no programmatic undo.
  Restore from your own backup if available.

The underlying `enableUndo` query parameter defaults to *true* upstream,
but the tool always sends it explicitly rather than inheriting a default
that could change: `permanent: true` sends `enableUndo=false`.

The dry-run output says which behaviour `commit: true` will apply:

> *"Would move the project to TRASH (restorable for ~60 days). Re-invoke with commit:true to apply."*
> or
> *"Would PERMANENTLY DELETE the project. Re-invoke with commit:true to apply. NO UNDO."*

The delete mode is journaled in `request.permanent`, and the reverter
re-checks it: reverting a permanent delete fails loudly with an
explanation rather than 404ing against `/restore`.

## See also

- [Daily admin](daily-admin.md), [Agile and views](agile-and-views.md), [Org admin](org-admin.md)
- [Commit-positive consent](../architecture/commit-positive-consent.md) —
  every destructive tool here requires `commit: true`
- [Operation journal](../architecture/operation-journal.md) — what gets
  captured for each mutation
- [API token side-channel](../oauth/api-token-side-channel.md) — the
  credential the `confluence.*` tools need
- [Full catalog with input schemas](catalog.md)

# Agile and views

The agile-process surface (boards, sprints, epics) and the filter /
dashboard configuration that drives Jira views.

8 tools carrying 18 operations across 4 permission groups. Most are
op-parameterized — one tool, several operations selected by a required
`op` field, called as `{ "op": "…", …args }`. The auto-generated
[catalog](catalog.md) has every input schema.

Fields listed as *Required* below are enforced for that op at dispatch;
passing a sibling op's field is an error that names the op the field
belongs to. A destructive op tool carries one `commit` flag shared by all
its ops. The pre-collapse names (`agile.listBoards`,
`filters.updateFilter`, …) still resolve for journal and revert purposes
— the mapping is at the bottom of the catalog.

## Agile (`read_agile` / `write_agile`)

**Credential:** OAuth. Everything here is the `/rest/agile/1.0` API.

### `agile.read` — 6 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listBoards` | — | Filter by `type` (`scrum`/`kanban`/`simple`), `name`, `projectKeyOrId` |
| `getBoard` | `boardId` | |
| `listSprints` | `boardId` | Filter by `state` (`future`/`active`/`closed`) |
| `getSprint` | `sprintId` | |
| `listEpics` | `boardId` | Filter by `done` |
| `getEpic` | `epicId` | Takes an epic **id or key** |

The paged ops (`listBoards`, `listSprints`, `listEpics`) take
`startAt` / `maxResults`, and the agile API caps `maxResults` at **50** —
lower than the 100 the `/rest/api/3` filter and dashboard reads allow.

### `agile.manageSprint` — 2 ops, destructive

| op | Required | Revertible |
|---|---|---|
| `createSprint` | `boardId`, `name` | no |
| `updateSprint` | `sprintId` | yes |

`createSprint` works on Scrum boards only, and takes optional `goal`,
`startDate`, `endDate` (ISO). It journals `revertible: false` — sprint
deletion is not part of this surface, so there is nothing to revert to.

`updateSprint` sets any of `name`, `goal`, `state`
(`future`/`active`/`closed`), `startDate`, `endDate`, `completeDate`.
Two things make it revertible and keep it that way:

- The upstream call is `POST /sprint/{id}`, which is a **partial**
  update. The op journals only the fields the caller actually touched,
  and the reverter decides what to restore by probing `k in
  entry.request` — so those journaled field names are a contract, not an
  implementation detail.
- A field the update *added* (one absent from the captured `before`) is
  sent back as `null` on revert, clearing it. Omitting it would leave the
  added value in place and silently half-revert the operation.

## Filters (`read_filters_dashboards` / `write_filters_dashboards`)

**Credential:** OAuth.

### `filters.read` — 2 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listFilters` | — | `startAt`, `maxResults`, `filterName`; runs `GET /filter/search` |
| `getFilter` | `filterId` | |

### `filters.manage` — 2 ops, destructive

| op | Required | Revertible |
|---|---|---|
| `createFilter` | `name`, `jql` | no |
| `updateFilter` | `filterId` | yes |

Both accept `description`, `favourite`, `sharePermissions[]`.

`PUT /filter/{id}` requires **both** `name` and `jql`. A JQL-only update
would 400 on its own, so `updateFilter` reads the filter first and merges
the existing values for whatever the caller didn't override. The revert
follows the same rule from the other side: it always sends the captured
`name` and `jql`, and restores `description` / `favourite` /
`sharePermissions` only for fields the update touched — falling back to
`""` / `false` / `[]` when `before` had no value, so a value the update
*added* is cleared rather than left behind.

### `filters.delete` — single-op, destructive, irreversible

`filters.delete(filterId, commit)`. Captures a full before-snapshot into
the journal for the audit trail, but journals `revertible: false` — Jira
has no filter restore.

## Dashboards (`read_filters_dashboards` / `write_filters_dashboards`)

**Credential:** OAuth.

Filters and dashboards share **one permission group**
(`*_filters_dashboards`) but two name prefixes, for visual clustering in
client UIs. That is also why the two deletes stayed separate single-op
tools instead of merging into one: a merged tool would have to pick one
prefix and hide the other half of the group.

### `dashboards.read` — 2 ops, read-only

| op | Required | Notes |
|---|---|---|
| `listDashboards` | — | `filter` scopes to `favourite` or `my` |
| `getDashboard` | `dashboardId` | |

### `dashboards.manage` — 2 ops, destructive

| op | Required | Revertible |
|---|---|---|
| `createDashboard` | `name` | no |
| `updateDashboard` | `dashboardId` | yes |

Both `POST /dashboard` and `PUT /dashboard/{id}` require `name`,
`sharePermissions` **and** `editPermissions` — none of them are
genuinely optional upstream even though all but `name` are optional on
the tool. `createDashboard` substitutes `[]` for either permission array
you omit; `updateDashboard` carries the dashboard's existing values
forward for anything not overridden.

The revert PUTs the captured `before` back and always sends
`description`, defaulting to `""`, so a description the update added is
cleared instead of surviving the revert.

### `dashboards.delete` — single-op, destructive, irreversible

`dashboards.delete(dashboardId, commit)`. Same shape as
`filters.delete`: before-snapshot journaled, `revertible: false`.

## See also

- [Daily admin](daily-admin.md), [Schemes and workflows](schemes-and-workflows.md), [Org admin](org-admin.md)
- [Commit-positive consent](../architecture/commit-positive-consent.md) —
  every destructive tool here requires `commit: true`
- [Operation journal](../architecture/operation-journal.md) — what gets
  captured for each mutation
- [Full catalog with input schemas](catalog.md)

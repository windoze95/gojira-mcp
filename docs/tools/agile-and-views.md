# Agile and views

The agile-process surface (boards, sprints, epics) and the filter /
dashboard configuration that drives Jira views.

About 18 tools across 4 permission groups.

## Agile (`read_agile` / `write_agile`)

**Credential:** OAuth.

### Boards
- `agile.listBoards(startAt?, maxResults?, type?, name?, projectKeyOrId?)`.
- `agile.getBoard(boardId)`.

### Sprints
- `agile.listSprints(boardId, state?, startAt?, maxResults?)`.
- `agile.getSprint(sprintId)`.
- `agile.createSprint(boardId, name, goal?, startDate?, endDate?)` — destructive.
- `agile.updateSprint(sprintId, name?, goal?, state?, startDate?, endDate?, completeDate?)` — destructive, revertible.

### Epics
- `agile.listEpics(boardId, startAt?, maxResults?, done?)`.
- `agile.getEpic(epicId)`.

## Filters (`read_filters_dashboards` / `write_filters_dashboards` — filter tools)

**Credential:** OAuth.

- `filters.listFilters(startAt?, maxResults?, filterName?)`.
- `filters.getFilter(filterId)`.
- `filters.createFilter(name, jql, description?, favourite?, sharePermissions[]?)` — destructive.
- `filters.updateFilter(filterId, name?, jql?, description?, favourite?, sharePermissions[]?)` — destructive, revertible.
- `filters.deleteFilter(filterId)` — destructive, irreversible.

## Dashboards (`read_filters_dashboards` / `write_filters_dashboards` — dashboard tools)

**Credential:** OAuth.

Note: filters and dashboards share **one permission group**
(`*_filters_dashboards`) but two name prefixes for visual clustering in
client UIs.

- `dashboards.listDashboards(startAt?, maxResults?, filter?)`.
- `dashboards.getDashboard(dashboardId)`.
- `dashboards.createDashboard(name, description?, sharePermissions[]?)` — destructive.
- `dashboards.updateDashboard(dashboardId, name?, description?, sharePermissions[]?)` — destructive, revertible.
- `dashboards.deleteDashboard(dashboardId)` — destructive, irreversible.

## See also

- [Daily admin](daily-admin.md), [Schemes and workflows](schemes-and-workflows.md), [Org admin](org-admin.md)
- [Full catalog with input schemas](catalog.md)

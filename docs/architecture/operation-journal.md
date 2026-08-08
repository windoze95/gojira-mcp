# Operation journal

Every destructive admin write is journaled with a snapshot of the prior
state. The journal answers the question *"what did this user change in
Atlassian yesterday?"* in a single tool call
(`gojira.readJournal(op: "listRecentOperations")`), and for the revertible
subset enables one-call undo via `gojira.revertOperation`.

## Layout

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `op_journal:<accountId>:<opId>` | String (JSON) | `GOJIRA_OPERATION_JOURNAL_TTL_DAYS` (default 30) | Full entry |
| `op_journal_idx:<accountId>` | Sorted set (score=completedAt ms) | same | Index for paged listing |

## Entry shape

```ts
interface JournalEntry {
  opId: string;                       // UUID, also returned in audit log
  accountId: string;                  // bearer identity
  tool: string;                       // the COLLAPSED tool, e.g. "customfields.manage"
  cloudId: string | null;
  target: {
    kind: string;                     // e.g. "custom_field", "jira_project"
    id?: string;
    key?: string;
    name?: string;
    parent?: string;                  // e.g. service desk id for a queue
    [k: string]: unknown;
  };
  before: unknown;                    // snapshot fetched pre-mutation, or null
  after: unknown;                     // result of the mutation
  request: Record<string, unknown>;   // input args, tokens/secrets redacted;
                                      // op-tool entries carry a flat top-level
                                      // `op` (see below), `commit` is stripped
  requestedAt: string;                // ISO-8601
  completedAt: string;                // ISO-8601
  outcome: "success" | "failure" | "dry_run";
  revertible: boolean;                // only true when reverter exists AND outcome=success
  revertHint?: string;                // operator-readable instructions for manual undo
  errorCode?: string;                 // populated on failure
  errorMessage?: string;
}
```

## Wrapper pattern

Tools that mutate Atlassian use `ctx.journalOp` from the per-call context.
`ctx.defaultJournalArgs` supplies `accountId` / `tool` / `cloudId`, so a
handler only declares what is specific to the mutation:

```ts
// inside customfields.manage, op "createCustomField"
const entry = await ctx.journalOp({
  ...ctx.defaultJournalArgs,
  target: { kind: "custom_field", name: input.name },
  before: null,
  request: body as Record<string, unknown>,
  revertible: true,
  revertHint: "DELETE /rest/api/3/field/{id} on the created field.",
  deriveTargetId: (after) => (after as { id?: string })?.id,
  run: async () => {
    const resp = await ctx.client.jira().post<{ id: string }>("/rest/api/3/field", body);
    return resp.data;
  },
});
```

`journalOp` runs the mutation inside a try/catch, calls
`journal.complete()` on both success and failure, and re-throws errors
with the journal entry attached (`(err as any).journalEntry`).

### `request.op` on op-tool entries

`entry.tool` is the **collapsed** tool name — `customfields.manage`, not
`customfields.createCustomField`. Which operation ran is recorded as a flat
top-level `op` inside `request`:

```jsonc
{ "tool": "customfields.manage",
  "request": { "op": "createCustomField", "name": "Color", "type": "..." } }
```

Handlers don't write that field. `src/tools/defs/defineOpTool.ts` wraps
`ctx.journalOp` per call and injects `{ op: spec.op, ...request }`, stripping
`commit` (consent plumbing, not part of the operation). Single-op tools built
with plain `defineTool` — `projects.delete`, `confluence.setContentRestrictions`,
`automation.createRuleFromTemplate`, `gojira.revertOperation` and the rest —
journal no `op` at all, and their bare `tool` fully identifies the operation.

The field is load-bearing: reverter resolution keys on it (below).

### Why pre-fetch `before`

For *update* operations the tool fetches the current state with a GET
before the mutation. That GET is part of the call's budget but lets us
record the exact prior payload — invaluable for diff inspection and for
manual restoration when an op is marked irreversible.

For *create* operations `before` is `null`.

For *delete* operations `before` is the GET result of the target right
before the DELETE; this is the only record that survives the deletion
and is the basis for the "what did we just delete?" audit query.

## Listing and inspection

`gojira.readJournal` covers the read path with two ops:

- `op: "listRecentOperations"` (`limit?`, `since?`, `until?`) — paged tail of
  the ZSET index.
- `op: "getOperation"` (`op_id`) — full entry with before/after snapshots.

`gojira.revertOperation(op_id, commit?)` is the write path — see below.

## Revert

`src/operations/revert.ts` maintains a registry of reverters. Keys come in
two shapes, because tools do:

- **`tool#op`** for the op-parameterized tools. An op declares `revert:` in
  its `defineOp` spec and `defineOpTool` registers it as
  `${tool}#${op}` — e.g. `customfields.manage#createCustomField`. `#` cannot
  occur in a tool name or an op name, so the two namespaces never collide.
- **bare tool name** for the three single-op keepers that still have a
  reverter: `projects.delete`, `confluence.setContentRestrictions`, and
  `automation.createRuleFromTemplate`. These call
  `reverters.register("<name>", async (entry, ctx) => { ... })` near the
  bottom of their definition file.

`canonicalReverterKey(entry)` (in `src/operations/legacyAliases.ts`) turns a
journal entry into its key: a non-empty `request.op` gives `tool#op`,
otherwise the bare `entry.tool`. An entry whose key isn't registered fails
closed — an operation not listed in the tables below has no reverter, and
`gojira.revertOperation` will refuse it even if you think it "should" be
undoable.

### Pre-collapse entries and the legacy alias map

The journal has a 30-day TTL, so after the CRUD collapse it still holds
entries written under the old per-endpoint names
(`customfields.createCustomField`, `agile.updateSprint`, …). Those names are
no longer tools and are not registry keys.

`src/operations/legacyAliases.ts` bridges the gap. Every op carrying a
`legacyName` (and every 1:1 rename, like `projects.deleteJiraProject` →
`projects.delete`) registers `oldName → { tool, op }` at load time, populated
from the specs themselves rather than a hand-maintained list, so it cannot
drift from the live catalog. When an entry has no `request.op`,
`canonicalReverterKey` consults the map before falling back to the bare name;
an old name resolves to `tool#op` (or to the bare rename target) and reverts
normally. An unknown name resolves to nothing and still fails closed. The map
is deletable once every pre-collapse entry has aged out — journal TTL plus
slack — and until then it doubles as the audit/SIEM name-migration table
published in the [tool catalog appendix](../tools/catalog.md).

### The flow

1. Caller invokes `gojira.revertOperation(op_id)` — without `commit:true`
   this returns a dry-run summary.
2. `assertRevertible(entry)`:
   - `entry.revertible === true` (set only on success)
   - `entry.outcome === "success"`
   - a reverter is registered under `canonicalReverterKey(entry)`
3. The **group gate**: a revert executes the original tool's inverse
   mutation, so it demands that tool's permission group, not just `utility`.
   `canonicalToolName(entry)` resolves the entry's tool through the same
   alias map — so a pre-collapse entry is gated on the group of the tool that
   absorbed it — and the resulting def must exist and belong to an enabled
   group. This applies to the dry-run branch too, since the dry run reveals
   before/after state the caller's surface never exposed.
4. With `commit:true`, `resolveForEntry(entry)` (the same canonical key
   again) yields the reverter, which runs with the caller's credentials and
   executes the inverse mutation. **The revert itself becomes a new journal
   entry.**

All three lookups — the `assertRevertible` check, the group gate, and the
commit-time resolve — go through the alias map, so a pre-collapse entry is
never half-accepted: it either passes every gate or none of them.

`gojira.revertOperation` runs with `authMethod: "oauth_or_api_token"` and
`needsCloudId: true`: it resolves whichever credential the caller has
(OAuth-backed reverters need the OAuth client; automation reverters need
the bound API-token client) and always resolves a cloudId. If the journal
entry's `cloudId` differs from the cloudId the revert call resolves to,
the revert is refused rather than replayed against the wrong site.

Two containment properties follow from this. The reverter executes with
the **caller's** credentials, not some stored ambient admin credential —
so a revert can never do anything the caller could not have done directly.
And journal lookup is scoped by `accountId`, so one user cannot revert
another user's operation; an `op_id` they do not own simply does not
resolve.

The three tables below are the complete registry — all 31 keys, exactly what
`reverters.names()` returns. `tests/tools/opRevertCoverage.test.ts` enforces
both directions: every op that claims revertibility has a key, and no key
points at a tool or op that no longer exists.

### Revertible daily-admin operations

| Registry key | Inverse |
|---|---|
| `projects.manage#archiveJiraProject` | `POST /rest/api/3/project/{id}/restore` |
| `projects.delete` | `POST /rest/api/3/project/{key}/restore` — **only** when the delete moved the project to trash (`permanent: false`, the default). A permanent delete journals `request.permanent: true` and the reverter refuses. |
| `customfields.manage#createCustomField` | `DELETE /rest/api/3/field/{id}` |
| `customfields.manage#updateCustomField` | `PUT` the captured `before` name/description/searcherKey back |
| `customfields.manage#assignCustomFieldToProjects` | remove the recorded project ids from the context again |
| `automation.manageRule#createAutomationRule` | disable, then `DELETE /rule/{uuid}` |
| `automation.createRuleFromTemplate` | disable, then `DELETE /rule/{uuid}` |
| `automation.manageRule#updateAutomationRule` | `PUT` the captured `before` rule back to the same UUID |
| `automation.manageRule#enableAutomationRule` | `PUT /rule/{uuid}/state` restoring the captured prior state (`{value: ...}`) |
| `automation.manageRule#disableAutomationRule` | `PUT /rule/{uuid}/state` restoring the captured prior state (`{value: ...}`) |
| `jsm.manage#createRequestType` | `DELETE` the created request type |
| `jsm.manage#addCustomersToOrganization` | remove the customers it added from the organization |
| `jsm.delete#removeCustomersFromOrganization` | add the customers it removed back to the organization |
| `forms.manageTemplate#createFormTemplate` | `DELETE` the created form template |
| `forms.manageTemplate#updateFormTemplate` | `PUT` the captured `before` template back |
| `assets.manageSchema#updateObjectSchema` | `PUT` the captured `before` name/key/description back |
| `assets.manageSchema#updateObjectType` | `PUT` the captured `before` object type back |
| `assets.manageSchema#updateObjectTypeAttribute` | `PUT` the captured `before` attribute back |
| `assets.manageObject#updateObject` | `PUT` the captured `before` attribute values back |

Assets *creates* are not revertible; only those four update ops are.

### Revertible schemes/workflows/Confluence operations

| Registry key | Inverse |
|---|---|
| `schemes.managePermission#assignPermissionSchemeToProject` | reassign the captured `before.id` |
| `schemes.managePermission#createPermissionScheme` | DELETE the created scheme |
| `schemes.managePermission#updatePermissionScheme` | `PUT` the captured `before` scheme back |
| `schemes.manageNotification#createNotificationScheme` | DELETE the created scheme |
| `schemes.manageNotification#updateNotificationScheme` | `PUT` the captured `before` scheme back |
| `workflows.manage#createWorkflow` | DELETE the created workflow(s) by entity id |
| `confluence.manageSpace#createConfluenceSpace` | DELETE the created space |
| `confluence.manageSpace#updateConfluenceSpace` | `PUT` the captured `before` space back |
| `confluence.setContentRestrictions` | `PUT` the captured `before` restrictions back, or DELETE to clear them when there were none |

### Revertible agile & views operations

| Registry key | Inverse |
|---|---|
| `agile.manageSprint#updateSprint` | `POST` the captured `before` sprint back |
| `filters.manage#updateFilter` | `PUT` the captured `before` filter back |
| `dashboards.manage#updateDashboard` | `PUT` the captured `before` dashboard back |

### Intentionally irreversible

Some destructive operations have no programmatic inverse and are journaled
anyway (so you can see *what* was changed) but cannot be reverted by the
server:

- `projects.delete` with `permanent: true` — a permanent delete has no undo
- `projects.manage#createJiraProject` — archiving a project is not the same
  as un-creating it, and deletion is a separately gated operation
- the deletes: `customfields.delete`, `confluence.delete`,
  `workflows.delete`, `automation.delete`, `forms.delete`,
  `filters.delete`, `dashboards.delete`,
  `schemes.delete#deletePermissionScheme`,
  `schemes.delete#deleteNotificationScheme`, `jsm.delete#deleteRequestType`,
  and every op of `assets.delete`
- the Assets and filter/dashboard/sprint *creates*
  (`assets.manageObject#createObject`,
  `assets.manageSchema#createObjectSchema`,
  `assets.manageSchema#createObjectType`,
  `assets.manageSchema#createObjectTypeAttribute`,
  `filters.manage#createFilter`, `dashboards.manage#createDashboard`,
  `agile.manageSprint#createSprint`)
- `assets.startImport` — an import cannot be un-run
- `workflows.manage#updateWorkflow` — the full `before` of every targeted
  workflow *is* captured, but undo means re-applying it yourself through
  that same op; there is no registered reverter
- `customfields.manage#setCustomFieldOptions` — an upsert, not a replace: it
  can add options but never remove them, so re-applying `before` would not
  undo a create
- `workflows.manage#publishWorkflowSchemeDraft` — a publish cannot be
  un-published
- **every `orgAdmin.*` write** (`orgAdmin.manageUser`, `orgAdmin.manageGroup`,
  `orgAdmin.delete`, `orgAdmin.setOrgPolicy`) — deliberately excluded.
  Reverting a user deactivation, a group membership, or an org policy is a
  privilege-escalation vector, so these journal `revertible: false` by design
  even where an inverse API exists. `defineOpTool` refuses at load time to
  build an `admin_org` tool whose ops carry reverters, so the exclusion
  cannot be undone by accident.

Note that queues carry no writes at all (the public API is read-only), so
there is no queue delete to revert.

For these the `revertHint` field in the journal entry tells the operator
how to manually restore (if possible) — e.g., from a Confluence space
trash, from an Atlassian-side backup, or by recreating from the captured
`before` snapshot.

## Size considerations

Workflow and scheme snapshots can be 100 KB+. With 30-day retention and
hundreds of operations per user, Redis pressure is real. Current default
allocations:

- `redis: maxmemory 256mb` in docker-compose
- `allkeys-lru` eviction policy
- `--appendonly yes` for durability

If journal pressure becomes a problem, consider offloading payloads to disk
(`/var/lib/gojira/journal/<accountId>/<opId>.json`) and keeping only the
index in Redis. The journal API would need a small `getEntry` extension to
read from disk on demand. Not currently implemented.

## See also

- [Commit-positive consent](commit-positive-consent.md) — the dry-run /
  patch system layered above the journal
- [`gojira.revertOperation`](../tools/utility.md)
- [Audit trail](../security/audit-trail.md)

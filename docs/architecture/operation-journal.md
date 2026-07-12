# Operation journal

Every destructive admin write is journaled with a snapshot of the prior
state. The journal answers the question *"what did this user change in
Atlassian yesterday?"* in a single tool call (`gojira.listRecentOperations`),
and for the revertible subset enables one-call undo via
`gojira.revertOperation`.

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
  tool: string;                       // e.g. "customfields.createCustomField"
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
  request: Record<string, unknown>;   // input args with tokens/secrets redacted
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

Tools that mutate Atlassian use `ctx.journalOp` from the per-call context:

```ts
const entry = await ctx.journalOp({
  accountId: ctx.accountId,
  tool: "customfields.createCustomField",
  cloudId: ctx.cloudId,
  target: { kind: "custom_field", name: input.name },
  before: null,
  request: body as Record<string, unknown>,
  revertible: true,
  revertHint: "DELETE /rest/api/3/field/{id} on the created field.",
  run: async () => {
    const resp = await ctx.client.jira().post<{ id: string }>("/rest/api/3/field", body);
    return resp.data;
  },
});
```

`journalOp` runs the mutation inside a try/catch, calls
`journal.complete()` on both success and failure, and re-throws errors
with the journal entry attached (`(err as any).journalEntry`).

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

Three utility tools cover the read path:

- `gojira.listRecentOperations(limit?, since?, until?)` — paged tail of the
  ZSET index.
- `gojira.getOperation(op_id)` — full entry with before/after snapshots.
- `gojira.revertOperation(op_id, commit?)` — see below.

## Revert

`src/operations/revert.ts` maintains a registry of reverters keyed by tool
name. Each tool that supports revert calls `reverters.register("<name>",
async (entry, ctx) => { ... })` near the bottom of its definition file.

The flow:

1. Caller invokes `gojira.revertOperation(op_id)` — without `commit:true`
   this returns a dry-run summary.
2. The wrapper checks `assertRevertible(entry)`:
   - `entry.revertible === true` (set only on success)
   - `entry.outcome === "success"`
   - a reverter is registered for `entry.tool`
3. With `commit:true`, the reverter runs through the normal tool path
   (auth + rate limit + audit), executing the inverse mutation. **The
   revert itself becomes a new journal entry.**

`gojira.revertOperation` runs with `authMethod: "oauth_or_api_token"` and
`needsCloudId: true`: it resolves whichever credential the caller has
(OAuth-backed reverters need the OAuth client; automation reverters need
the bound API-token client) and always resolves a cloudId. If the journal
entry's `cloudId` differs from the cloudId the revert call resolves to,
the revert is refused rather than replayed against the wrong site.

### Revertible daily-admin operations

| Tool | Inverse |
|---|---|
| `projects.archiveJiraProject` | `POST /rest/api/3/project/{key}/restore` |
| `customfields.createCustomField` | `DELETE /rest/api/3/field/{id}` |
| `automation.createAutomationRule` | disable, then `DELETE /rule/{uuid}` |
| `automation.createRuleFromTemplate` | disable, then `DELETE /rule/{uuid}` |
| `automation.updateAutomationRule` | `PUT` the captured `before` rule back to the same UUID |
| `automation.enableAutomationRule` | `PUT /rule/{uuid}/state` restoring the captured prior state (`{value: ...}`) |
| `automation.disableAutomationRule` | `PUT /rule/{uuid}/state` restoring the captured prior state (`{value: ...}`) |
| `jsm.createQueue` | `DELETE` the queue |
| `jsm.createRequestType` | `DELETE` the request type |

### Revertible schemes/workflows operations

| Tool | Inverse |
|---|---|
| `schemes.assignPermissionSchemeToProject` | reassign the captured `before.id` |
| `schemes.createPermissionScheme` | DELETE the created scheme |
| `schemes.createNotificationScheme` | DELETE the created scheme |
| `workflows.createWorkflow` | DELETE the created workflow |
| `confluence.createConfluenceSpace` | DELETE the created space |

### Intentionally irreversible

Some destructive operations have no programmatic inverse and are journaled
anyway (so you can see *what* was deleted) but cannot be reverted by the
server:

- `projects.deleteJiraProject` (unless `enableUndo:true` was used)
- `customfields.deleteCustomField`
- `confluence.deleteConfluenceSpace`
- `*.delete*` for queues/request-types/SLAs/forms
- destructive ops on Assets (Atlassian's APIs don't expose un-delete)

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

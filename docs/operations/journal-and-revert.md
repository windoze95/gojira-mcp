# Journal and revert — operator playbook

For the mechanics see
[operation-journal.md](../architecture/operation-journal.md). This page
is the runbook side: how to use the journal day-to-day.

## "What did Claude do in our Jira yesterday?"

Use `gojira.listRecentOperations` from your own MCP session.

```jsonc
// tool call
{
  "tool": "gojira.listRecentOperations",
  "input": {
    "since": "2026-05-10T00:00:00Z",
    "until": "2026-05-11T00:00:00Z",
    "limit": 100
  }
}
```

Returns the caller's **own** entries. To inspect another user's
journal, you'd need direct Redis access; the tool surface is per-user
by design.

```bash
# operator query: another user's recent ops
ACCOUNT=70121:abcd...
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    ZREVRANGEBYSCORE "op_journal_idx:$ACCOUNT" "+inf" "-inf" LIMIT 0 50
# returns opIds; then for each:
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    GET "op_journal:$ACCOUNT:<opId>" | jq
```

## "I want to undo what I just did"

For revertible operations:

```jsonc
{ "tool": "gojira.revertOperation", "input": { "op_id": "<uuid>" } }
// returns dry-run summary

{ "tool": "gojira.revertOperation", "input": { "op_id": "<uuid>", "commit": true } }
// performs the inverse mutation
```

The revert is itself journaled. If you re-revert, the *revert* op
becomes the new entry — the chain stays auditable.

## "It says revertible: false. Can I still undo?"

Yes — manually, using the captured `before` snapshot.

1. `gojira.getOperation(op_id)` → returns the full entry including the
   `before` payload.
2. Decide which tool reproduces that prior state. For:
   - An update: re-PUT the `before` body.
   - A delete of something the inverse-create tool covers (e.g.,
     deleted custom field): use the create tool with the captured
     `before` shape.
   - A delete of something un-recreatable (e.g., `projects.deleteJiraProject`
     without `enableUndo:true`): you need an out-of-band backup.

The `revertHint` field in the journal entry calls out the recommended
approach.

## "Disk pressure from the journal"

Each entry's size is roughly `len(before) + len(after) + ~200 bytes of
overhead`. Workflows and schemes are the largest; expect ~50 KB-200 KB
per such entry.

To estimate journal pressure:

```bash
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    --bigkeys 2>/dev/null | grep -E "op_journal|op_journal_idx" || true
```

To free space without changing retention:

- `GOJIRA_OPERATION_JOURNAL_TTL_DAYS=14` (or smaller); restart;
  existing keys retain their original TTL but new ones use the new
  value.
- `FLUSHDB` is too coarse — it nukes everything including encrypted
  tokens.

Targeted cleanup:

```bash
# delete journal entries older than N days for a specific user
ACCOUNT=70121:abcd...
CUTOFF=$(date -u -d '14 days ago' +%s)000   # ms epoch
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    ZRANGEBYSCORE "op_journal_idx:$ACCOUNT" -inf "$CUTOFF"
# returns opIds to delete; pipe through xargs DEL op_journal:<ACCOUNT>:<opId>
```

## "I don't trust the journal — what failsafe do I have?"

The audit sink runs in parallel:

- audit records carry `operation_id` matching the journal `opId`
- audit failures are logged but don't block journal writes
- journal failures are caught inside `journalOp` and the original error
  is re-raised — the entry is *not* written if the mutation failed
  before the journal save, but the audit sink still records the
  failure

So the audit log is the more durable history. The journal is the
deeper history (with before/after) that powers revert.

If both fail (Redis down): the mutation still happens against
Atlassian, the audit goes to stdout (default), and the journal entry
is lost. Recovery is "scan stdout/file logs by `operation_id` and
correlate with Atlassian's own change history."

## "Adding a revertible operation later"

Suppose you ship a new tool today. Operations performed before today
have no reverter registered, so `gojira.revertOperation` returns:

```
VALIDATION_ERROR: No reverter registered for tool '<name>'.
```

If you later register a reverter for that tool, **future ops are
revertible; past ops are still not** (the journal entry has the same
`tool` string, so theoretically the new reverter would apply, but
revertibility is also gated on `entry.revertible === true` which was
written at journal-write time). Specifically, `assertRevertible` checks
both flags.

Bottom line: revert is forward-looking. Don't expect to retroactively
make old entries revertible.

## "Show me ops by tool"

There's no tool-indexed query in the journal API yet. To enumerate by
tool:

```bash
# all entries for one user, then filter by tool
ACCOUNT=70121:abcd...
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    ZREVRANGEBYSCORE "op_journal_idx:$ACCOUNT" "+inf" "-inf" |
xargs -I {} docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    GET "op_journal:$ACCOUNT:{}" |
jq 'select(.tool == "customfields.createCustomField")'
```

For org-wide queries, scan all `op_journal_idx:*` users, or
preferably ship audit records to a SIEM and query there. The journal
is per-user storage; the audit sink is the right place for cross-user
queries.

## See also

- [Operation journal (architecture)](../architecture/operation-journal.md)
- [Utility tools](../tools/utility.md) — `listRecentOperations`,
  `getOperation`, `revertOperation`
- [Incident response](incident-response.md)
- [Audit trail](../security/audit-trail.md)

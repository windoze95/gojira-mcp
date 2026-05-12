# Audit trail

Every tool call writes exactly one structured audit record. The record
is JSON, one per line for stdout/file targets, JSON-body for HTTP, and
syslog-encoded for syslog targets.

## Record shape

```json
{
  "ts": "2026-05-11T16:00:00.000Z",
  "level": "audit",
  "event": "tool_call",
  "actor": {
    "account_id": "70121:abcd...",
    "name": null,
    "email": null
  },
  "tool": "customfields.createCustomField",
  "group": "write_customfields",
  "cloud_id": "abc-123",
  "client_id": "uuid-of-mcp-client",
  "request": { "name": "Color", "type": "..." },
  "outcome": "success",
  "error_code": null,
  "duration_ms": 142,
  "operation_id": "uuid"
}
```

`admin_org` records additionally carry an `org_id` field.

### Fields

| Field | Meaning |
|---|---|
| `ts` | ISO-8601 UTC timestamp when the record was emitted (after the tool returned). |
| `level` | Always `"audit"` for these records — separable from operational `pino` logs. |
| `event` | Always `"tool_call"`. |
| `actor.account_id` | The bearer's `accountId` (load-bearing — see [auth-bridge.md](../architecture/auth-bridge.md)). |
| `actor.name`, `actor.email` | Reserved; populated from `StoredToken` if available. |
| `tool` | The dotted tool name. |
| `group` | The tool's permission group (e.g. `read_jsm_admin`, `admin_org`, `utility`). |
| `cloud_id` | The resolved cloudId for this call (pinned or primary). `null` for utility / org-admin. |
| `client_id` | The MCP client's registered client_id. |
| `request` | The parsed input, with keys matching `token`, `secret`, or `password` redacted as `[REDACTED]`. |
| `outcome` | `"success"`, `"failure"`, or `"dry_run"`. |
| `error_code` | One of the tool error codes when `outcome=failure`; `null` otherwise. |
| `duration_ms` | Wall-clock duration from tool entry to envelope emission. |
| `operation_id` | UUID matching the `operation_id` returned in the success envelope and the journal entry's `opId`. |
| `org_id` | `admin_org` tools only. |

## Targets

`GOJIRA_AUDIT_LOG_TARGET` accepts one of:

| Form | Meaning |
|---|---|
| `stdout` | One JSON line per record to process stdout. Default. |
| `file:/path/to/log` | One JSON line per record appended to the file. The file is opened/closed per write — log rotation is safe. Pre-opened once at startup to surface permission issues. |
| `http://...` or `https://...` | One POST per record, body is the record as JSON. 5 s timeout; failures log a warn and drop the record. |
| `syslog:<facility>` | UDP to localhost:514 with RFC 3164 PRI prefix + JSON body. Severity is fixed at `informational` (6). |

`admin_org` records additionally use `GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET`
if set, otherwise they fall through to the main target.

## Redaction

The `request` field is sanitized via `sanitizeRequest`:

```ts
for (const [k, v] of Object.entries(args)) {
  if (/token|secret|password/i.test(k)) out[k] = "[REDACTED]";
  else out[k] = v;
}
```

This catches `gojira.bindApiToken({ token: "..." })` and similar. The
field-name pattern is conservative — anything explicitly named with one
of those words is redacted. Other sensitive content (e.g., a JQL clause
that happens to embed a secret) would not be caught by this rule.

The pino logger has additional redact paths for ambient logging:
`*.token`, `*.access_token`, `*.refresh_token`, `*.client_secret`,
`*.password`, `req.query.token`, `req.headers.authorization`,
`req.headers.cookie`.

## Outcome values

| Outcome | When |
|---|---|
| `"success"` | Tool ran, returned a non-dry-run result. |
| `"failure"` | Tool threw. `error_code` populated. |
| `"dry_run"` | Tool returned a dry-run payload from `buildDryRunIfNotCommitted`. The tool itself didn't do anything, but the call still uses budget — useful to know how often the model is exploring before committing. |

## Cross-references

The triplet `operation_id` / `reference_id` / journal `opId`:

- `operation_id` in the audit record matches the journal entry's `opId`.
- `reference_id` in an error envelope is its own UUID, logged with the
  underlying exception at error level — *not* the same as
  `operation_id`. Use it to find the stack in operator logs.
- Successful destructive operations have both: the audit `operation_id`
  pinpoints the call, and the journal entry pinpoints the mutation.

## What this is NOT

- **Not the operation journal.** The journal carries before/after
  snapshots, lives in Redis for 30 days, and powers revert. The audit
  sink is fire-and-forget operational logging — meant for SIEM and
  forensics, not for replay.
- **Not a transaction log.** A successful audit record does not imply
  the mutation succeeded inside the journal (write may have failed
  silently to the journal). Cross-reference both for full confidence.
- **Not a HTTP access log.** `/health` calls don't emit audit records;
  only tool calls do.

## Practical queries

```bash
# tail the file target
tail -F /var/log/gojira/audit.log | jq

# all destructive calls in the last hour
jq 'select(.tool | test("create|update|delete|enable|disable|assign|set|publish|provision|deactivate|verify|restore|archive|remove|import"))
    | select(.ts > (now - 3600 | strftime("%Y-%m-%dT%H:%M:%SZ")))' /var/log/gojira/audit.log

# every admin_org action by a specific actor
jq 'select(.group == "admin_org" and .actor.account_id == "70121:abcd")' \
    /var/log/gojira/org-admin.log
```

## See also

- [Error codes](error-codes.md)
- [Operation journal](../architecture/operation-journal.md)
- [Refresh reuse](refresh-reuse.md) — a separate audit-grade event with
  its own log line + optional webhook

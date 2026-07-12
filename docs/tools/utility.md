# Utility tools

Seven tools in the `utility` permission group. They register whenever
`utility` is listed in `GOJIRA_ENABLED_GROUPS` — which every standard
deployment pattern includes, because these tools are how clients
introspect what's available.

These tools cover server introspection, identity, side-channel credential
binding, and operation-journal access. They are the *only* tools that
work in a freshly-initialized session before any other setup.

## `gojira.health`

Returns liveness state including a Redis `PING`. Useful for monitoring
inside the MCP transport (the `/health` HTTP endpoint covers the
external-monitoring case).

**Auth:** none. (Still requires a bearer to reach `/mcp`; just doesn't
need a user.)

**Returns:**

```json
{
  "status": "ok",
  "redis": "ok",
  "oauth_issuer": "https://gojira.example.com",
  "pinned_cloud_id": "abc-123",
  "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"],
  "org_admin_enabled": false,
  "duration_ms": 3,
  "ts": "2026-05-11T16:00:00.000Z"
}
```

`status: "degraded"` and `redis: "fail"` if the Redis ping doesn't
return `PONG`.

## `gojira.whoami`

Returns the caller's identity plus the deployment's relevant scopes.

**Auth:** OAuth (StoredToken required).

**Returns:**

```json
{
  "account_id": "70121:abcd...",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "accessible_cloud_ids": ["cloud-1", "cloud-2"],
  "primary_cloud_id": "cloud-1",
  "pinned_cloud_id": "cloud-1",
  "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"],
  "bound_api_token": true,
  "org_admin_enabled": false
}
```

Use this immediately after auth to verify the deployment's surface
matches what the use case needs.

## `gojira.bindApiToken`

Bind a per-user Atlassian API token for tools that don't accept OAuth.

**Auth:** OAuth (the caller binds *their own* API token).

**Input:**

```json
{
  "email": "jane@example.com",
  "token": "ATATT3xFfGF0...<base64-ish atlassian api token>",
  "site_url": "acme.atlassian.net",
  "cloud_id": "optional; auto-set to pinned value if pinning is enabled"
}
```

The handler:

1. Validates the token against `https://<site_url>/rest/api/3/myself`.
2. Asserts the response's `accountId` matches `ctx.accountId` (prevents
   cross-user binding).
3. Persists to `apitoken:<accountId>` encrypted at rest.

**Returns:** `{ bound: true, account_id, display_name, cloud_id, site_url }`.

Generate the API token at
`https://id.atlassian.com/manage-profile/security/api-tokens` first.

See [api-token-side-channel.md](../oauth/api-token-side-channel.md) for
the full credential model.

## `gojira.listEnabledTools`

Lists every tool, marking which are available to this caller. Useful for
clients that want to build their own grouped UI or for the model to
discover what it can do without enumerating itself.

**Auth:** none.

**Returns:**

```json
{
  "deployment": {
    "org_admin_enabled": false,
    "pinned_cloud_id": "cloud-1",
    "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"]
  },
  "caller": { "has_api_token": true },
  "by_group": {
    "read_jsm_admin": ["jsm.listServiceDesks", "..."]
  },
  "tools": [
    {
      "name": "jsm.listServiceDesks",
      "group": "read_jsm_admin",
      "auth_method": "api_token",
      "destructive": false,
      "available": true
    },
    {
      "name": "projects.deleteJiraProject",
      "group": "delete_projects",
      "auth_method": "oauth",
      "destructive": true,
      "available": false,
      "reason": "group 'delete_projects' is not enabled on this deployment"
    },
    "..."
  ]
}
```

## `gojira.listRecentOperations`

Returns the caller's recent journal entries (newest first).

**Auth:** OAuth.

**Input:**

```json
{
  "limit": 25,
  "since": "2026-05-10T00:00:00Z",
  "until": "2026-05-11T00:00:00Z"
}
```

All inputs optional. Defaults: `limit=25`, no time bound.

**Returns:**

```json
{
  "count": 3,
  "entries": [
    {
      "op_id": "uuid",
      "tool": "customfields.createCustomField",
      "target": { "kind": "custom_field", "id": "10101", "name": "Color" },
      "completed_at": "2026-05-11T15:32:00.000Z",
      "outcome": "success",
      "revertible": true,
      "error_code": null
    }
  ]
}
```

## `gojira.getOperation`

Returns a single journal entry with full before/after snapshots.

**Auth:** OAuth.

**Input:** `{ "op_id": "uuid" }`.

**Returns:** the full `JournalEntry` — see
[operation-journal.md](../architecture/operation-journal.md) for the
shape.

## `gojira.revertOperation`

Replays the inverse of a previously-journaled operation, if a reverter
is registered.

**Auth:** OAuth *or* bound API token (`oauth_or_api_token`) — whichever the
caller has is loaded, and the reverter's client enforces what it actually
needs (e.g. automation reverters need the bound API token). Requires a
resolvable cloudId and refuses to revert an entry journaled on a different
cloudId.

**Input:**

```json
{
  "op_id": "uuid",
  "commit": true
}
```

Without `commit:true`, returns a dry-run describing what the revert
would do, including the original operation's target, before, and after.

**Returns** on `commit:true`:

```json
{
  "reverted": true,
  "result": { /* whatever the inverse mutation returned */ },
  "original_op_id": "uuid"
}
```

**Errors:**

- `NOT_FOUND` if `op_id` is unknown.
- `VALIDATION_ERROR` if the original op is not revertible (failed op,
  intentionally irreversible op, or no reverter registered for its tool).

The revert itself becomes a new journal entry, so the audit chain
remains complete: original op → revert op → (if you re-revert) revert-of-
revert op.

See [journal-and-revert.md](../operations/journal-and-revert.md) for the
operational playbook.

## See also

- [Tools overview](overview.md)
- [Permission groups](permission-groups.md)
- [Operation journal](../architecture/operation-journal.md)

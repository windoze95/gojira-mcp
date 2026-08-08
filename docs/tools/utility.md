# Utility tools

Six tools (seven operations) in the `utility` permission group. They
register whenever `utility` is listed in `GOJIRA_ENABLED_GROUPS` — which
every standard deployment pattern includes, because these tools are how
clients introspect what's available.

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
  "instance": "jsm-admin",
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

Returns the caller's identity plus this instance's relevant scopes.

**Auth:** OAuth (StoredToken required).

**Returns:**

```json
{
  "account_id": "70121:abcd...",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "accessible_cloud_ids": ["cloud-1", "cloud-2"],
  "primary_cloud_id": "cloud-1",
  "instance": "jsm-admin",
  "pinned_cloud_id": "cloud-1",
  "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"],
  "bound_api_token": true,
  "org_admin_enabled": false
}
```

Use this immediately after auth to verify the instance's surface matches
what the use case needs.

## `gojira.bindApiToken`

Bind a per-user Atlassian API token for tools that don't accept OAuth
(JSM admin, automation, Confluence).

**Auth:** OAuth (the caller binds *their own* API token).

**Input:**

```json
{
  "email": "jane@example.com",
  "token": "ATATT3xFfGF0...<base64-ish atlassian api token>",
  "site_url": "acme.atlassian.net",
  "cloud_id": "optional; rejected if it disagrees with site_url's real cloudId"
}
```

The handler:

1. Resolves `site_url`'s **true** cloudId from
   `https://<site_url>/_edge/tenant_info`.
2. Rejects a supplied `cloud_id` that doesn't match that resolved value.
3. Rejects the binding if this instance pins a cloudId and the site's
   cloudId isn't it. Load-bearing, not belt-and-braces: the api-token
   clients route on `site_url` while the pin is enforced on `cloud_id`, so
   a token bound with the pinned `cloud_id` and *another* tenant's
   `site_url` would otherwise pass the guard and send every
   JSM/Confluence call to the wrong tenant.
4. Validates the credential against `https://<site_url>/rest/api/3/myself`.
5. Asserts the response's `accountId` matches `ctx.accountId` (prevents
   cross-user binding).
6. Persists to `apitoken:<accountId>` encrypted at rest, storing the
   proven cloudId.

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

**Input:** `{ "available_only": true }` — optional; when true, only the
tools actually callable on this instance are returned (and `by_group` is
narrowed to match). Omit it to see the whole catalog with per-tool
`reason` strings for anything unavailable.

**Returns:**

```json
{
  "deployment": {
    "instance": "jsm-admin",
    "org_admin_enabled": false,
    "pinned_cloud_id": "cloud-1",
    "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"]
  },
  "caller": { "has_api_token": true },
  "by_group": {
    "read_jsm_admin": ["jsm.readServiceDesk", "jsm.readSupport", "forms.read"]
  },
  "tools": [
    {
      "name": "jsm.readServiceDesk",
      "group": "read_jsm_admin",
      "auth_method": "api_token",
      "destructive": false,
      "ops": ["listServiceDesks", "getServiceDesk", "listRequestTypes", "..."],
      "available": true
    },
    {
      "name": "projects.delete",
      "group": "delete_projects",
      "auth_method": "oauth",
      "destructive": true,
      "available": false,
      "reason": "group 'delete_projects' is not enabled on this instance (it may be served by a sibling gojira-mcp instance)"
    },
    "..."
  ]
}
```

`ops` appears only on op-parameterized tools and lists the values its
required `op` field accepts; single-op tools omit the key. The other two
`reason` strings are `"org admin disabled on this instance"` and
`"requires a bound API token (call gojira.bindApiToken)"`.

## `gojira.readJournal`

Reads the operation journal (30-day rolling window). Two ops:

| op | Input | Returns |
|---|---|---|
| `listRecentOperations` | `limit` (≤200, default 25), `since`, `until` — all optional ISO-8601 for the bounds | `{ count, entries[] }`, newest first |
| `getOperation` | `op_id` (uuid) | the full `JournalEntry`, including before/after snapshots |

**Auth:** OAuth.

**Returns** for `{ "op": "listRecentOperations", "limit": 25 }`:

```json
{
  "count": 3,
  "entries": [
    {
      "op_id": "uuid",
      "tool": "customfields.manage",
      "target": { "kind": "custom_field", "id": "10101", "name": "Color" },
      "completed_at": "2026-05-11T15:32:00.000Z",
      "outcome": "success",
      "revertible": true,
      "error_code": null
    }
  ]
}
```

The list projection names the *tool*; which op ran is in the entry's
`request.op`, which only `getOperation` returns. See
[operation-journal.md](../architecture/operation-journal.md) for the full
entry shape.

## `gojira.revertOperation`

Replays the inverse of a previously-journaled operation, if a reverter
is registered.

**Auth:** OAuth *or* bound API token (`oauth_or_api_token`) — whichever the
caller has is loaded, and the reverter's client enforces what it actually
needs (e.g. automation reverters need the bound API token). Requires a
resolvable cloudId.

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
  "journal_id": "uuid-of-the-revert-entry",
  "original_op_id": "uuid"
}
```

An unknown `op_id` is `NOT_FOUND`. Beyond that, three guards run before
anything is replayed, and all three apply to the dry run too — a dry run
reveals before/after state the caller's surface may never have exposed:

- The entry must be revertible: `VALIDATION_ERROR` for a failed op, an
  intentionally irreversible op, or one with no reverter registered.
- When the entry and this call both carry a cloudId, they must be the
  same one — never revert against a different tenant.
- **The original tool's permission group must be enabled here.** A revert
  executes that tool's inverse mutation, so `utility` alone is not enough;
  otherwise any instance sharing the journal's Redis (split-surface
  profiles do) could re-run a sibling's write surface through its journal
  entries. Denial is `INSUFFICIENT_PERMISSIONS`, naming the instance that
  journaled the op so you know where to reconnect.

Entries written before the CRUD collapse are still in window (30-day TTL);
their pre-collapse names resolve through the legacy alias map to the
current tool and op, for both the group gate and the reverter lookup. A
name that resolves to no def fails closed.

The revert itself becomes a new journal entry, so the audit chain
remains complete: original op → revert op → (if you re-revert) revert-of-
revert op.

See [journal-and-revert.md](../operations/journal-and-revert.md) for the
operational playbook.

## See also

- [Tools overview](overview.md)
- [Permission groups](permission-groups.md)
- [Operation journal](../architecture/operation-journal.md)
- [MCP Apps UI](../architecture/mcp-apps-ui.md) — `gojira.readJournal`
  renders as a timeline with a revert preview in UI-capable hosts

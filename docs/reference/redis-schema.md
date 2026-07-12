# Redis schema

Authoritative table of every key pattern gojira-mcp reads or writes.
TTLs and types are exact; sizes are typical.

| Key pattern | Type | TTL | Encryption | Purpose |
|---|---|---|---|---|
| `oauth_client:<client_id>` | String (JSON) | 90 days | none | Dynamically registered MCP OAuth client (RFC 7591). |
| `pending_auth:<id>` | String (JSON) | 10 min | none | MCP client's PKCE/redirect captured during /authorize. |
| `atlassian_state:<state>` | String (JSON) | 10 min | none | CSRF state for the upstream leg. **Consumed via `GETDEL`.** |
| `auth_code:<code>` | String (JSON) | 5 min | none | gojira-issued auth code. **Consumed via `GETDEL`.** |
| `mcp_token:<at>` | String (JSON) | 1 hour | none | MCP access token → `{ accountId, clientId, scopes, expiresAt, familyId }`. |
| `mcp_refresh:<rt>` | String (JSON) | 30 days | none | MCP refresh token → `{ accountId, clientId, scopes, familyId, generation }`. |
| `rt_family:<rt>` | String | 31 days | none | Per-RT pointer to its family. Outlives the RT for reuse-detection grace. |
| `refresh_family:<familyId>` | Set | 30 days | none | Currently-live RT ids in the family. |
| `refresh_family_tokens:<familyId>` | Set | 30 days | none | Currently-live AT ids in the family. |
| `token:<accountId>` | String (base64) | 90 days sliding | **AES-256-GCM** | Upstream Atlassian StoredToken: access_token, refresh_token, expires_at, accountId, name, email, accessible_cloud_ids[], primary_cloud_id. |
| `apitoken:<accountId>` | String (base64) | None (manual revoke) | **AES-256-GCM** | Per-user Atlassian API token side-channel. |
| `token_refresh_lock:<accountId>` | String (UUID) | 10 sec | none | Distributed lock for the upstream refresh path. CAD release via Lua. |
| `ratelimit:<accountId>` | Hash | 120 sec | none | Token-bucket: `tokens`, `last_refill_ms`, `reset_floor_until_ms`. |
| `op_journal:<accountId>:<opId>` | String (JSON) | `GOJIRA_OPERATION_JOURNAL_TTL_DAYS` (default 30 days) | none | Journal entry: tool, target, before, after, request, outcome, revertible. |
| `op_journal_idx:<accountId>` | Sorted set (score = completedAt ms) | same | none | Index for `gojira.listRecentOperations`. |
| `assets_workspace:<cloudId>` | String | 24 hours | none | Cached Assets workspaceId per cloud site. |

There is deliberately **no key for org-admin caller verification**.
That gate is a static allowlist read from `GOJIRA_ORG_ADMIN_ACCOUNT_IDS`
at process start (see [org-admin token](../oauth/org-admin-token.md)) —
nothing to cache, nothing to invalidate.

## Naming conventions

- All keys are colon-separated: `<class>:<id>` or
  `<class>:<scope>:<id>`.
- Per-user data uses `accountId` as the scope, never the email or
  display name (those can change; accountId is opaque and stable).
- Atlassian-side ephemera (state, codes, tokens) use random hex
  generated at issue time.

## Atomic operations

Only a handful of paths use atomic operations beyond simple `SET/GET`:

- `GETDEL` for one-time-use consumption: `atlassian_state:*`,
  `auth_code:*`.
- Lua eval for the rate-limiter (`BUCKET_SCRIPT`, `FEEDBACK_SCRIPT`).
- Lua compare-and-delete for the upstream-refresh lock release.
- Pipelines for token mint (`mcp_token:*`, `mcp_refresh:*`,
  `rt_family:*` set together) and for journal write (`op_journal:*` +
  `op_journal_idx:*`).

## Garbage collection

Most keys have explicit TTLs. The exceptions:

- `apitoken:<accountId>` — no TTL because users manage their own API
  tokens at id.atlassian.com. Operator must DEL on revocation.
- `oauth_client:<client_id>` — TTL set to 90 days at registration
  time, refreshed only on rotation. Stale clients age out.

Idle bucket cleanup is automatic via the `EXPIRE key window*2`
inside the Lua script.

## Operator queries

Common one-liners (assume `REDIS_PASSWORD` is set):

```bash
# count tokens currently issued
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    --scan --pattern "token:*" | wc -l

# inspect an active session bearer
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    GET "mcp_token:<at>" | jq

# enumerate live RT families (find a user's family then SMEMBERS)
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    SMEMBERS "refresh_family:<familyId>"

# bucket state for a user
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    HGETALL "ratelimit:<accountId>"

# operation journal index for a user
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    ZREVRANGEBYSCORE "op_journal_idx:<accountId>" "+inf" "-inf" LIMIT 0 25

# delete a single op journal entry
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    DEL "op_journal:<accountId>:<opId>"
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    ZREM "op_journal_idx:<accountId>" "<opId>"
```

## Migration notes

There is no migration story today — this is v0. Future schema changes
should:

- Use new key prefixes rather than mutating existing ones.
- Provide a one-shot migrator script under `scripts/`.
- Keep the old prefix readable until users have aged out (TTL-based).

## See also

- [Auth bridge](../architecture/auth-bridge.md)
- [Operation journal](../architecture/operation-journal.md)
- [Refresh-token rotation](../architecture/refresh-token-rotation.md)
- [Backup and recovery](../operations/backup.md)

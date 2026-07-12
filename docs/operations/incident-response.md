# Incident response

Concrete playbooks for the incident classes gojira-mcp is most likely
to encounter.

## Incident: Refresh-token reuse detected

**Trigger:** `REFRESH_TOKEN_REUSE` log line, or a webhook fired to
`GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK`.

**Severity:** High by default; could be benign (client bug or race) or
malicious (theft).

**Playbook:**

1. The family is already destroyed automatically — no action needed
   to stop further attacker access.
2. Identify the user from the event's `accountId`.
3. Reach out to the user; confirm whether they noticed any unexpected
   logout or behaviour.
4. If suspicious: walk through
   [refresh-reuse.md](../security/refresh-reuse.md) — pivot to the
   audit log to enumerate any tool calls in the window before the
   reuse event, then to the journal to inspect the actual changes,
   then revert what's reversible.
5. If benign (client bug or race): note the client's name + version
   from the audit log's `client_id`; file with the client developers.

## Incident: Atlassian credential leakage

**Trigger:** Discovery that an Atlassian token, the encryption key, or
the Atlassian client secret has leaked out of band (e.g., committed
to git, posted in chat, found in a backup).

**Playbook by what leaked:**

### `TOKEN_ENCRYPTION_KEY` leaked

Catastrophic if the attacker also has Redis access. If they don't, the
key alone is useless.

1. Generate a new key (`npm run generate-key`).
2. Decide on a window: announce a maintenance period (5-10 minutes is
   enough).
3. Stop the service.
4. Update `TOKEN_ENCRYPTION_KEY` in your secret store.
5. Delete every `token:*` and `apitoken:*` from Redis — they're
   unreadable under the new key anyway:
   ```bash
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       --scan --pattern "token:*" | xargs -L 100 redis-cli ... DEL
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       --scan --pattern "apitoken:*" | xargs -L 100 redis-cli ... DEL
   ```
6. Also revoke `refresh_family:*` and the corresponding `mcp_token:*`,
   `mcp_refresh:*`, `rt_family:*` keys — bearers issued under the old
   key reference Atlassian credentials that won't decrypt:
   ```bash
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       --scan --pattern "mcp_*" | xargs -L 100 redis-cli ... DEL
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       --scan --pattern "refresh_family*" | xargs -L 100 redis-cli ... DEL
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       --scan --pattern "rt_family:*" | xargs -L 100 redis-cli ... DEL
   ```
7. Restart the service.
8. All users re-authenticate from scratch.

### `ATLASSIAN_OAUTH_CLIENT_SECRET` leaked

1. Atlassian developer console → rotate secret.
2. Update env var; restart.
3. Existing user sessions continue (the bearer is fine); upstream
   refresh uses the new secret on next refresh.
4. The leaked secret can no longer authenticate to Atlassian's token
   endpoint as gojira-mcp. Old AT/RT pairs already issued by Atlassian
   continue to work until they expire — gojira-mcp keeps using them
   until refresh.
5. Audit any token-endpoint logs at Atlassian for unexpected exchanges
   under the old secret.

### `GOJIRA_ORG_ADMIN_TOKEN` leaked

Catastrophic.

1. **Immediately revoke** at admin.atlassian.com.
2. Generate a new token; update env; restart the org-admin instance.
3. Pivot to `org-admin` audit channel — every `admin_org` op is logged
   with `org_id`. Enumerate suspicious activity in the window between
   leak and revocation.
4. Notify your security team and (if applicable) Atlassian support.

### Per-user Atlassian API token leaked (the one bound via `gojira.bindApiToken`)

1. The user revokes at id.atlassian.com — immediate upstream
   invalidation.
2. Operator clears the cached binding:
   ```bash
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       DEL "apitoken:<accountId>"
   ```
3. Audit all JSM/Assets calls under that account in the leak window.

## Incident: admin_org abuse

**Trigger:** Unexpected `orgAdmin.*` calls in the org-admin audit log.

**Playbook:**

**Contain first.** The caller passed the gate because their accountId is
on the `GOJIRA_ORG_ADMIN_ACCOUNT_IDS` allowlist. Remove it from the
org-admin instance's env and **restart** — the allowlist is read at
process start, so nothing changes until you do. (Removing their org-admin
role at admin.atlassian.com does *not* close this gate; the tools run on
the deployment's `GOJIRA_ORG_ADMIN_TOKEN`, not the caller's credential.
Do both.)

Then reconstruct and undo:

1. Filter the org-admin audit log by the suspicious `accountId` and
   timeframe.
2. For each `tool_call` with `outcome:"success"`, look up the
   `operation_id` in the journal for before/after snapshots.
3. **Undo by hand.** `admin_org` ops are deliberately *not*
   auto-revertible: `gojira.revertOperation` lives in the `utility` group
   and is not org-admin gated, so a reverter here would be a way around
   the gate. Every mutating org-admin journal entry carries
   `revertible: false` and a `revertHint` naming the inverse tool — call
   it explicitly, from an allowlisted account:

   | Abused op | Undo with |
   |---|---|
   | `deactivateUser` | `orgAdmin.restoreUser` (same accountId) |
   | `restoreUser` | `orgAdmin.deactivateUser` (same accountId) |
   | `addUserToGroup` | `orgAdmin.removeUserFromGroup` (same accountId + groupId) |
   | `removeUserFromGroup` | `orgAdmin.addUserToGroup` (same accountId + groupId) |
   | `createGroup` | `orgAdmin.deleteGroup` (group id is in the journal `after` payload) |
   | `setOrgPolicy` | `orgAdmin.setOrgPolicy` with the journal `before` payload as `body` |
   | `provisionUser`, `deleteGroup` | **irreversible** — remediate at admin.atlassian.com |

4. If the abuse came through a shared credential rather than a person,
   the allowlist gives you no accountability: split it into per-human
   accountIds before re-enabling.

## Incident: Service down

**Trigger:** `/health` returns non-200 or the container is unhealthy.

**Playbook:**

1. `docker compose ps` — is gojira-mcp running? Restart if exited.
2. `docker compose logs gojira-mcp --tail 200` — look for a fatal
   error.
3. `docker compose logs redis --tail 50` — Redis dependency check.
4. `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" PING` —
   verify Redis from inside the network.
5. If config errors: `docker compose config | grep -i environment`
   and verify `.env` is correct.
6. If TLS cert issues (Caddy overlay): `docker compose logs caddy
   --tail 100`.

Common root causes:

- Bad env var (loader exits 1 with `Configuration error: ...` on
  stdout).
- Redis password rotated but env not updated.
- Disk full (Redis can't write AOF).
- Atlassian outage causing every refresh to 5xx — gojira itself is
  fine but every tool call returns `UPSTREAM_UNAVAILABLE`.

## Incident: Atlassian rate-limit storm

**Trigger:** spike in `RATE_LIMITED` errors in audit log; sustained
NearLimit signals.

**Playbook:**

1. Identify the offending user(s) by audit log `actor.account_id`
   counts.
2. Inspect their bucket state:
   ```bash
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       HGETALL "ratelimit:<accountId>"
   ```
3. If a single user is the cause: lower their effective rate by either
   shrinking `RATE_LIMIT_PER_USER` (global) or revoking their bearer
   to force a backoff.
4. If model behaviour is the cause (e.g., a chat in a tight loop):
   coordinate with the user; consider reducing
   `GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT` to be more aggressive about
   pre-emptive throttling, or vice versa.
5. Atlassian-side rate limiting is global per-tenant; if many users on
   the same site are running tools simultaneously, you may need to
   stagger.

## Incident: Stuck publish workflow

**Trigger:** `workflows.publishWorkflow` returned `status: "RUNNING"` and
hasn't completed.

**Playbook:**

1. Re-fetch the task: `GET /rest/api/3/task/<taskId>` directly via
   the Jira REST API (or write a one-off tool).
2. Atlassian publish takes longer than 15 seconds for large workflows
   sometimes. Wait and retry.
3. If `status: "FAILED"`: Atlassian's response includes the failure
   reason. Common cause is in-flight issues whose status doesn't appear
   in `statusMappings`.

## See also

- [Refresh reuse](../security/refresh-reuse.md)
- [Threat model](../security/threat-model.md)
- [Backup and recovery](backup.md)
- [Audit trail](../security/audit-trail.md)

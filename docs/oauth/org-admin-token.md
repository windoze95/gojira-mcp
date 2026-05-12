# Org-admin token

The org-admin APIs at `api.atlassian.com/admin/v1/orgs/<orgId>/*` do not
accept OAuth tokens. There is no per-user delegated path. Atlassian only
exposes them with **org-admin API tokens** — credentials a human
organization administrator generates at `admin.atlassian.com` and which
act as that admin.

This is a fundamentally different credential model from the rest of the
server. gojira-mcp treats it carefully.

## Storage and shape

The org-admin token is a **single global server-side secret**:

| | |
|---|---|
| Env var | `GOJIRA_ORG_ADMIN_TOKEN` |
| Location | In-memory after process start; never persisted by gojira |
| Encryption | At-rest encryption is your secret-manager's responsibility (Vault, AWS Secrets Manager, sops-encrypted env file) |
| Per-user | **No.** All `admin_org` calls run with the same upstream credential. |

There is no per-user variant because Atlassian doesn't offer one. Caller
identity is preserved via gojira's audit + caller-verification path
described below, not by per-user upstream credentials.

## The gate

The `admin_org` group is **disabled by default**. Three checks must all
pass for an `admin_org` tool to run:

1. `GOJIRA_ENABLE_ORG_ADMIN=true` at process start (else the entire
   `admin_org` permission group is unregistered from the tool surface
   and never reaches the dispatch path).
2. `GOJIRA_ORG_ADMIN_TOKEN` and `GOJIRA_ORG_ID` are both set
   (`config.ts` refuses to start otherwise).
3. Per-call **caller verification**: the user's accountId must appear in
   the org's admin roster.

## Caller verification

`src/auth/orgAdminVerifier.ts` checks that the calling user is themselves
an org admin before running an `admin_org` tool:

```
ctx.accountId
   │
   ▼
GET org_admin_verified:<accountId> from Redis
   │
   ├─ cached "yes" within 5 min → allow
   ├─ cached "no" within 5 min → deny
   │
   ▼ (miss)
GET /admin/v1/orgs/<orgId>/users (paginated, follows cursors)
   ├─ caller's accountId appears → SET cache "yes" EX 300 → allow
   └─ caller's accountId not found after pagination → SET cache "no" EX 300 → deny
```

A "no" verdict surfaces as `INSUFFICIENT_PERMISSIONS` with the message
*"Caller is not an organization admin"*.

5-minute cache TTL balances tool-call latency against revocation
freshness; if you remove someone from org admin, they'll keep running
`admin_org` tools for up to 5 more minutes.

## Recommended deployment shape

```
Production instance A
  GOJIRA_ENABLE_ORG_ADMIN=false
  pinned to prod cloudId
  (day-to-day admin surface; can never reach admin.atlassian.com)

Production instance B (org-admin only, separate hostname, separate port)
  GOJIRA_ENABLE_ORG_ADMIN=true
  GOJIRA_ORG_ADMIN_TOKEN=<secret>
  GOJIRA_ORG_ID=<orgId>
  GOJIRA_ENABLED_GROUPS=utility,admin_org
  GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET=file:/var/log/gojira/org-admin.log
  (org-admin only; accessed by a small set of admins; separate audit channel)
```

Why two instances:

- The org-admin token is fundamentally more dangerous than per-user
  delegated tokens. Isolating its blast radius means an accidental
  configuration mistake in the day-to-day instance simply cannot reach
  admin APIs.
- The instances can have different OAuth client registrations, allowing
  the org-admin instance to require additional auth gates that the
  day-to-day instance doesn't.
- Audit streams remain separable.

Running everything on one instance is supported (set
`GOJIRA_ENABLE_ORG_ADMIN=true` and include `admin_org` in
`GOJIRA_ENABLED_GROUPS` alongside the rest of the surface), but the
isolation property weakens.

## Audit isolation

Org-admin operations write to a separate audit channel via
`GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET`, defaulting to the main target when
unset. Recommended: explicit separate target (file, HTTP, syslog) for
SIEM separation.

Audit record shape includes `org_id` for org-admin calls:

```json
{
  "ts": "2026-05-11T16:00:00.000Z",
  "level": "audit",
  "event": "tool_call",
  "actor": { "account_id": "...", "name": null, "email": null },
  "tool": "orgAdmin.deactivateUser",
  "group": "admin_org",
  "cloud_id": null,
  "client_id": "...",
  "request": { "accountId": "<target>" },
  "outcome": "success",
  "error_code": null,
  "duration_ms": 142,
  "operation_id": "...",
  "org_id": "<orgId>"
}
```

## Concrete tools

See [org-admin.md](../tools/org-admin.md) for the full list. Highlights:

- `orgAdmin.listOrgUsers`, `orgAdmin.getOrgUser`
- `orgAdmin.provisionUser`, `orgAdmin.deactivateUser`, `orgAdmin.restoreUser`
- `orgAdmin.addUserToGroup` / `removeUserFromGroup`
- `orgAdmin.listGroups`, `orgAdmin.createGroup`, `orgAdmin.deleteGroup`
- `orgAdmin.getOrgPolicies`, `orgAdmin.setOrgPolicy`
- `orgAdmin.queryAuditLog`, `orgAdmin.listVerifiedDomains`, `orgAdmin.verifyDomain`
- `orgAdmin.listInstalledApps`, `orgAdmin.removeApp`
- `orgAdmin.getRovoMcpSettings`, `orgAdmin.setRovoMcpAllowedDomains`,
  `orgAdmin.setRovoMcpApiTokenAuth`

All destructive `admin_org` tools require `commit: true`.

## Secret rotation

To rotate `GOJIRA_ORG_ADMIN_TOKEN`:

1. Generate a new token at admin.atlassian.com (Atlassian supports
   multiple active org-admin tokens).
2. Update the env var on the org-admin instance.
3. Restart the service (`docker compose up -d --force-recreate`).
4. Revoke the old token at admin.atlassian.com.

There is no live-rotation path — the secret is read at process start and
held in-memory.

## See also

- [Threat model](../security/threat-model.md) — org-admin isolation rationale
- [Audit trail](../security/audit-trail.md) — separate org-admin channel
- [Environment variables](../deployment/environment-variables.md) — full
  config reference

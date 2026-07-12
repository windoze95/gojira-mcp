# Org admin

The most dangerous surface. All 17 `admin_org` tools route through
`api.atlassian.com/admin/v1/orgs/<orgId>/*` using a single
**org-admin API token** (`GOJIRA_ORG_ADMIN_TOKEN`). There is no
per-user delegated path — Atlassian doesn't expose one.

The `admin_org` group is **disabled by default**. Operator opts in via:

```bash
GOJIRA_ENABLE_ORG_ADMIN=true
GOJIRA_ORG_ADMIN_TOKEN=<secret>
GOJIRA_ORG_ID=<orgId>
GOJIRA_ORG_ADMIN_ACCOUNT_IDS=<accountId>[,<accountId>...]
GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET=file:/var/log/gojira/org-admin.log
```

Recommendation: **deploy these tools on a separate instance** so the
org-admin blast radius is isolated from the day-to-day admin surface.
See [org-admin-token.md](../oauth/org-admin-token.md) for the rationale.

## Caller verification

Every `admin_org` tool call first checks the caller's accountId against
the **operator-declared allowlist** in `GOJIRA_ORG_ADMIN_ACCOUNT_IDS`.
There is no org-roster lookup and no verification cache: Atlassian has no
public endpoint that enumerates *only* org admins
(`/admin/v1/orgs/<orgId>/users` returns every managed account in the org,
so gating on it would let any licensed user act with the deployment's
global org-admin token). `src/auth/orgAdminVerifier.ts` therefore reads
the allowlist straight from config.

`config.ts` refuses to start (exit 1) if `GOJIRA_ENABLE_ORG_ADMIN=true`
and the allowlist is empty. An accountId not on the list gets
`INSUFFICIENT_PERMISSIONS` — *"Caller is not an authorized organization
admin for this instance."* with `details.hint` *"Add the caller's
Atlassian accountId to GOJIRA_ORG_ADMIN_ACCOUNT_IDS."* The gate fails
closed.

Removing someone's access means **removing their accountId from
`GOJIRA_ORG_ADMIN_ACCOUNT_IDS` and restarting** — the allowlist is read
at process start.

## Reverts

No `admin_org` tool registers a reverter, and every mutating tool here
journals `revertible: false`. This is deliberate:
`gojira.revertOperation` lives in the `utility` group and is **not**
org-admin gated, so a reverter on an `admin_org` tool would be a way to
perform org-admin mutations without passing the gate. Mutations still
journal `before`/`after` snapshots, and each carries a `revertHint`
naming the inverse `admin_org` tool to call by hand (which *is* gated).

## Audit isolation

`admin_org` tool calls write to a separate audit channel (the one set by
`GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET`, or the main target if unset). Each
record carries an `org_id` field absent from other tool calls.

## Tools

All tools route through `ctx.client.admin()` (base
`api.atlassian.com/admin/v1`). All destructive tools require
`commit: true`. None are auto-revertible; the *undo* column names the
inverse tool to call by hand.

### Users

- `orgAdmin.listOrgUsers(cursor?)` — paged.
- `orgAdmin.getOrgUser(accountId)`.
- `orgAdmin.provisionUser(email, displayName, profile?)` — destructive, irreversible.
- `orgAdmin.deactivateUser(accountId)` — destructive; undo: `orgAdmin.restoreUser`.
- `orgAdmin.restoreUser(accountId)` — destructive; undo: `orgAdmin.deactivateUser`.

### Group membership

- `orgAdmin.getUserGroups(accountId)`.
- `orgAdmin.addUserToGroup(accountId, groupId)` — destructive; undo: `orgAdmin.removeUserFromGroup`.
- `orgAdmin.removeUserFromGroup(accountId, groupId)` — destructive; undo: `orgAdmin.addUserToGroup`.

### Groups

- `orgAdmin.listGroups(cursor?)`.
- `orgAdmin.getGroup(groupId)`.
- `orgAdmin.createGroup(name, description?)` — destructive; undo: `orgAdmin.deleteGroup` with the id in the journal `after` payload.
- `orgAdmin.deleteGroup(groupId)` — destructive, irreversible.

### Policies

- `orgAdmin.getOrgPolicies(type?)`.
- `orgAdmin.setOrgPolicy(policyId, body)` — destructive; undo: `orgAdmin.setOrgPolicy` with the journal `before` payload as `body`.

### Audit, domains, accounts

- `orgAdmin.listManagedAccounts(cursor?)`.
- `orgAdmin.queryAuditLog(from?, to?, actor?, action?, product?, cursor?, limit?)`.
- `orgAdmin.listVerifiedDomains`.

### Deliberately absent

Domain *verification*, Marketplace app management (`listInstalledApps`,
`getApp`, `removeApp`) and the org-level Rovo MCP settings have no
endpoint under `admin/v1` — every candidate path 404s. Tools for them
were removed rather than shipped as guaranteed failures. Do those jobs in
the admin.atlassian.com UI.

## See also

- [Org-admin token (full security view)](../oauth/org-admin-token.md)
- [Threat model](../security/threat-model.md)
- [Audit trail](../security/audit-trail.md)
- [Full catalog with input schemas](catalog.md)

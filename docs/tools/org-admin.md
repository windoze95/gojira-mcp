# Org admin

The most dangerous surface. All 24 `admin_org` tools route through
`api.atlassian.com/admin/v1/orgs/<orgId>/*` using a single
**org-admin API token** (`GOJIRA_ORG_ADMIN_TOKEN`). There is no
per-user delegated path — Atlassian doesn't expose one.

The `admin_org` group is **disabled by default**. Operator opts in via:

```bash
GOJIRA_ENABLE_ORG_ADMIN=true
GOJIRA_ORG_ADMIN_TOKEN=<secret>
GOJIRA_ORG_ID=<orgId>
GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET=file:/var/log/gojira/org-admin.log
```

Recommendation: **deploy these tools on a separate instance** so the
org-admin blast radius is isolated from the day-to-day admin surface.
See [org-admin-token.md](../oauth/org-admin-token.md) for the rationale.

## Caller verification

Every `admin_org` tool call first verifies that the **calling user** is
themselves an org admin (membership in
`/admin/v1/orgs/<orgId>/users?role=admin`). The verdict is cached for 5
minutes per accountId at `org_admin_verified:<accountId>`.

`INSUFFICIENT_PERMISSIONS` with the message *"Caller is not an
organization admin"* surfaces to non-admin callers.

## Audit isolation

`admin_org` tool calls write to a separate audit channel (the one set by
`GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET`, or the main target if unset). Each
record carries an `org_id` field absent from other tool calls.

## Tools

All tools route through `ctx.client.admin()` (base
`api.atlassian.com/admin/v1`). All destructive tools require
`commit: true`.

### Users

- `orgAdmin.listOrgUsers(cursor?)` — paged.
- `orgAdmin.getOrgUser(accountId)`.
- `orgAdmin.provisionUser(email, displayName, profile?)` — destructive, irreversible.
- `orgAdmin.deactivateUser(accountId)` — destructive, revertible.
- `orgAdmin.restoreUser(accountId)` — destructive, revertible.

### Group membership

- `orgAdmin.getUserGroups(accountId)`.
- `orgAdmin.addUserToGroup(accountId, groupId)` — destructive, revertible.
- `orgAdmin.removeUserFromGroup(accountId, groupId)` — destructive, revertible.

### Groups

- `orgAdmin.listGroups(cursor?)`.
- `orgAdmin.getGroup(groupId)`.
- `orgAdmin.createGroup(name, description?)` — destructive, revertible.
- `orgAdmin.deleteGroup(groupId)` — destructive, irreversible.

### Policies

- `orgAdmin.getOrgPolicies(type?)`.
- `orgAdmin.setOrgPolicy(policyId, body)` — destructive, revertible.

### Audit, domains, accounts

- `orgAdmin.listManagedAccounts(cursor?)`.
- `orgAdmin.queryAuditLog(from?, to?, actor?, action?, product?, cursor?, limit?)`.
- `orgAdmin.listVerifiedDomains`.
- `orgAdmin.verifyDomain(domain)` — destructive.

### Marketplace apps

- `orgAdmin.listInstalledApps`.
- `orgAdmin.getApp(appId)`.
- `orgAdmin.removeApp(appId)` — destructive, irreversible.

### Rovo MCP settings

The org-level settings that govern the **official** Atlassian Rovo MCP
endpoint.

- `orgAdmin.getRovoMcpSettings`.
- `orgAdmin.setRovoMcpAllowedDomains(domains[])` — destructive, revertible.
- `orgAdmin.setRovoMcpApiTokenAuth(enabled)` — destructive, revertible.

## See also

- [Org-admin token (full security view)](../oauth/org-admin-token.md)
- [Threat model](../security/threat-model.md)
- [Audit trail](../security/audit-trail.md)
- [Full catalog with input schemas](catalog.md)

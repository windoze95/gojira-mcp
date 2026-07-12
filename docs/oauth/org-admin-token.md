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
   `GOJIRA_ORG_ADMIN_ACCOUNT_IDS`, the operator-declared allowlist —
   which `config.ts` also refuses to start without (exit 1) when org
   admin is enabled.

## Caller verification

Verification is an **operator-declared allowlist**, not a roster lookup.

Atlassian has no reliable public endpoint that enumerates *only* an org's
administrators: `GET /admin/v1/orgs/<orgId>/users` returns every managed
account in the org. Gating on that list would let **any licensed user**
pass the gate and act with the deployment's global org-admin token —
privilege escalation. So the set of accounts permitted to invoke
`admin_org` tools is declared explicitly by the operator instead.

`src/auth/orgAdminVerifier.ts`:

```
ctx.accountId
   │
   ▼
accountId ∈ GOJIRA_ORG_ADMIN_ACCOUNT_IDS ?
   ├─ yes → allow
   └─ no  → log warn { accountId, allowlistSize } → deny
```

The allowlist is read from config once at construction — no Redis, no
network call, no cache. An empty allowlist (with org admin enabled)
denies everyone; startup validation makes that state unreachable anyway.
It fails closed.

A denial surfaces as `INSUFFICIENT_PERMISSIONS`:

```json
{
  "code": "INSUFFICIENT_PERMISSIONS",
  "message": "Caller is not an authorized organization admin for this instance.",
  "details": {
    "hint": "Add the caller's Atlassian accountId to GOJIRA_ORG_ADMIN_ACCOUNT_IDS."
  }
}
```

If org admin is disabled entirely, the message is instead *"Org admin
tools are not enabled on this instance"*.

**Granting and revoking access is an operator action, not an Atlassian
one.** Editing someone's role at admin.atlassian.com does not change what
this instance permits: add or remove the accountId in
`GOJIRA_ORG_ADMIN_ACCOUNT_IDS` and restart. Removing an org admin
upstream while leaving them on the allowlist leaves them able to drive
the org-admin token — treat the two as one revocation procedure.

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
  GOJIRA_ORG_ADMIN_ACCOUNT_IDS=<accountId>[,<accountId>...]
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

See [org-admin.md](../tools/org-admin.md) for all 17. Highlights:

- `orgAdmin.listOrgUsers`, `orgAdmin.getOrgUser`
- `orgAdmin.provisionUser`, `orgAdmin.deactivateUser`, `orgAdmin.restoreUser`
- `orgAdmin.addUserToGroup` / `removeUserFromGroup`
- `orgAdmin.listGroups`, `orgAdmin.createGroup`, `orgAdmin.deleteGroup`
- `orgAdmin.getOrgPolicies`, `orgAdmin.setOrgPolicy`
- `orgAdmin.queryAuditLog`, `orgAdmin.listManagedAccounts`,
  `orgAdmin.listVerifiedDomains`

All destructive `admin_org` tools require `commit: true`. None register a
reverter — `gojira.revertOperation` is in the `utility` group and is not
org-admin gated, so an `admin_org` reverter would be a path around this
gate. Mutating tools journal `revertible: false` plus a `revertHint`
naming the inverse `admin_org` tool to call by hand.

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

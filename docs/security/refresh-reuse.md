# Refresh-token reuse detection

gojira-mcp treats a stale MCP refresh token (RT) as a theft signal only after a
fixed five-second idempotency boundary. A same-client, same-issuer duplicate
inside that window receives the exact immediate-successor pair if the child AT,
RT, and family membership are all still live.

For the Redis mechanics, see
[refresh-token-rotation.md](../architecture/refresh-token-rotation.md). This
page focuses on the security boundary, audit channel, and incident response.

## What a replay means

Two nearly simultaneous refreshes can be legitimate. Network retries and MCP
clients with overlapping request paths can both present the same RT before the
winning response is stored. The bounded receipt handles that case without a
logout or security alert.

A replay becomes a `REFRESH_TOKEN_REUSE` incident when its receipt has expired
or its immediate child is no longer live. At that point it can indicate:

1. **Theft.** An attacker captured an RT and presented it later.
2. **Client bug.** A client kept retrying an already-rotated RT beyond the
   recovery window.
3. **Lost response or delayed retry.** The client failed to persist the winning
   response and did not recover within five seconds.

The server cannot distinguish those cases at detection time. It therefore
burns the family after the bounded retry allowance.

## Idempotency boundary

The five-second `mcp_refresh_replay:<oldRt>` receipt is fixed and non-sliding.
Reading it never refreshes its TTL. Before returning it, the atomic Redis path
requires:

- the same OAuth `client_id`;
- the same gojira-mcp `issuer`;
- the exact immediate successor generation;
- a live successor AT and RT; and
- the successor RT still present in `refresh_family:<familyId>`.

Failure of any child-liveness check deletes the receipt and falls through to
stale-reuse handling. A receipt can never chain an old parent forward to a
later generation.

This boundary deliberately allows anyone possessing the old RT and legitimate
client identity to receive the winning pair for up to five seconds. Keeping the
window tiny, issuer-bound, and one-generation-only limits that tradeoff while
preventing legitimate concurrent Codex refreshes from revoking themselves.

## What gets burned

The same Redis Lua transition that classifies stale reuse removes:

```
mcp_refresh:<each live RT>
mcp_token:<each live AT>
refresh_family:<familyId>
refresh_family_tokens:<familyId>
```

The burn is atomic with classification, so a racing valid rotation cannot
recreate the family after revocation. Afterward:

- every live session from the family fails its next `/mcp` call;
- every refresh attempt by attacker or legitimate client gets
  `invalid_grant`;
- the user must reauthenticate via `/authorize`; and
- upstream Atlassian credentials at `token:<accountId>` remain untouched.

## Audit events

An accepted duplicate emits an info-level event and is not an incident:

```json
{
  "event": "REFRESH_TOKEN_IDEMPOTENT_REPLAY",
  "familyId": "...",
  "accountId": "...",
  "clientId": "...",
  "generation": 2
}
```

A stale replay emits a warn-level event after the atomic burn:

```json
{
  "event": "REFRESH_TOKEN_REUSE",
  "familyId": "...",
  "accountId": "...",
  "reason": "Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.",
  "refresh_tokens_revoked": 1,
  "access_tokens_revoked": 2
}
```

If `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` is configured, gojira-mcp POSTs
the reuse event with snake-case family/account fields and a `ts` value. The
request times out after five seconds; delivery failure is logged but does not
block the already-completed revocation.

Wire the webhook to:

- a SIEM that pages on reuse events;
- a Slack or PagerDuty security channel; or
- an internal incident-tracking system.

## Why it works

Rotation alone cannot distinguish a legitimate retry from a stolen token.
The combined design adds three controls:

- an active RT can rotate only once in a Redis-atomic transition;
- immediate legitimate duplicates converge on the exact winning pair; and
- the 31-day structured `rt_family:<rt>` index remembers client, issuer,
  family, and generation after the active RT and five-second receipt are gone.

Wrong-client and sibling-issuer attempts are rejected before mutation and do
not consume or revoke the legitimate family's credentials.

## Limitations

- **First-use stolen RT.** The attacker can win the first rotation. During the
  next five seconds, both holders can obtain the same child pair. A parent
  replay after that boundary burns the family. The attacker may still use the
  child AT until expiry or revocation.
- **Same-client theft inside five seconds.** The server intentionally cannot
  distinguish it from a legitimate concurrent retry. Correlate the
  informational replay event with network and client telemetry if available.
- **Sustained compromise.** An attacker holding current credentials and the
  legitimate client identity can keep rotating. Per-bearer access logs should
  surface geography, origin, or user-agent anomalies.
- **Access-token theft.** RT rotation does not protect an already-captured AT.
  Use TLS, never log bearers, and isolate operator hosts.
- **Already-stale legacy RT.** Pre-upgrade bare family indexes lack client and
  issuer binding. The server rejects them without revoking the family, because
  allowing an unbound stale token to burn a shared-Redis family would create a
  cross-instance denial-of-service path. Active legacy RTs upgrade on rotation;
  stale bare indexes age out after 31 days.

## Incident-response playbook

When you see a `REFRESH_TOKEN_REUSE` event:

1. **Identify the user.** Resolve `accountId` through recent
   `gojira.whoami` audit entries or the stored upstream token.
2. **Estimate the window.** Find the family's earliest bearer activity. The
   suspicious window ends at the reuse event.
3. **Enumerate damage.** Filter successful tool calls by `account_id` during
   that window.
4. **Inspect destructive operations.** Use `gojira.readJournal` with
   `listRecentOperations` or `getOperation` to review before/after state.
5. **Revert what is safely reversible.** Use
   `gojira.revertOperation(op_id, commit:true)` where supported.
6. **Notify and reauthenticate the user.** Review unrecognized Atlassian app
   grants and rotate upstream credentials if compromise is plausible.
7. **Hunt the source.** Check operator hosts, debug logs, shared environment
   files, proxies, and any other bearer-handling surface.

An isolated `REFRESH_TOKEN_IDEMPOTENT_REPLAY` event is expected retry telemetry,
not proof of compromise. Repeated events or unexpected origin changes deserve
investigation.

## See also

- [Refresh-token rotation (architecture)](../architecture/refresh-token-rotation.md)
- [Audit trail](audit-trail.md)
- [Incident response](../operations/incident-response.md)
- [Threat model](threat-model.md)

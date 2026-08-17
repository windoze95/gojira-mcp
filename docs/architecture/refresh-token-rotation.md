# Refresh-token rotation with bounded idempotency and reuse detection

gojira-mcp rotates every MCP-issued refresh token (RT) on exchange. A
legitimate duplicate refresh gets one fixed five-second recovery window; a
stale replay outside that boundary is always rejected and alerted. What happens
to the live successor family is controlled by `GOJIRA_REFRESH_REUSE_POLICY`:
`strict` revokes it, while `contain` preserves it for investigation.

This distinction matters for clients such as Codex that can issue two refresh
requests at nearly the same time. Treating the losing request as theft can
revoke the replacement credentials before the client stores them. The bounded
receipt makes that race idempotent without turning rotated tokens into
long-lived reusable credentials.

## Family layout

Every RT belongs to a **family**:

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `mcp_refresh:<rt>` | String (JSON) | 30 days | Active RT; includes `accountId`, `clientId`, `familyId`, `generation`, and `issuer`. |
| `mcp_token:<at>` | String (JSON) | 1 hour | Active access token (AT) in the same family. |
| `rt_family:<rt>` | String (JSON) | 31 days | Versioned family index: `{ v: 2, familyId, clientId, issuer, generation }`. Active RTs with legacy bare indexes remain readable and upgrade on rotation. |
| `mcp_refresh_replay:<oldRt>` | Hash | 5 seconds, fixed | Receipt containing the exact immediate-successor pair plus its client, issuer, family, account, and generation binding. |
| `mcp_refresh_reuse_notice:<oldRt>` | String | 5 minutes, fixed | Deduplicates contained-reuse alert delivery without changing rejection behavior. |
| `rt_family_account:<familyId>` | String | 31 days | Family-to-account attribution after an RT blob is gone. |
| `refresh_family:<familyId>` | Set | 30 days | Currently-live RT IDs in the family. |
| `refresh_family_tokens:<familyId>` | Set | 30 days | Currently-live AT IDs in the family. |

The two post-rotation records serve different purposes:

- `mcp_refresh_replay:<oldRt>` is the five-second idempotency receipt. Reading
  it never extends its TTL.
- A structured `rt_family:<rt>` outlives the active RT so a later replay can
  still identify, bind, and revoke the family. Its extra day also remembers an
  RT briefly after natural expiry.

## One atomic transition

`exchangeRefreshToken` parses the immutable Redis records and verifies their
client/issuer binding before mutation. It then supplies their exact raw values
as compare-and-swap guards to one Redis Lua script. The script handles every
rotation state atomically:

1. **Valid replay receipt:** verify `client_id` and `issuer`, then verify that
   the receipt's immediate child AT and RT still exist and that the child RT is
   still a member of the family. Return the exact pair minted by the winning
   request. Do not rewrite or extend the receipt.
2. **Active parent RT:** compare the active record, verify the upstream
   `token:<accountId>` still exists, remove the parent, create the successor AT
   and RT, update the family sets/indexes, and write the five-second receipt.
3. **Stale parent RT:** compare the structured family index and enumerate the
   live family. Under `strict`, delete every current AT, RT, and family set in
   the same Lua transition. Under `contain`, leave the live successor family
   untouched and return its counts for security telemetry.
4. **Changed record:** return `retry`; the provider rereads immutable state and
   retries at most three times.

Because Redis runs the script atomically, concurrent rotation and stale-reuse
requests cannot resurrect or partly revoke a family. They are serialized into
one live successor pair followed by either a complete strict-policy burn or a
contained rejection that preserves that pair.

## Concurrent refresh

```
request A ── rt1 ──┐
                   ├─ Redis-atomic transition
request B ── rt1 ──┘
                     A rotates rt1 → at2 + rt2 and writes a 5s receipt
                     B reads the receipt → returns that exact at2 + rt2
```

The accepted duplicate emits an informational
`REFRESH_TOKEN_IDEMPOTENT_REPLAY` event. It does not emit a security alert.

The receipt is deliberately one-generation only. If `rt2` has already rotated
to `rt3`, has been revoked, or is no longer in the family set, replaying `rt1`
cannot return dead credentials or chain forward to `rt3`; it follows the stale
reuse path instead.

## Reuse detection

A bound stale presentation becomes reuse when the old RT is no longer active
and either:

- its fixed five-second receipt has expired, or
- its immediate successor is no longer fully live.

The configured policy determines the family action, OAuth error, and event:

- **`strict`** atomically burns every current AT and RT, then emits
  `REFRESH_TOKEN_REUSE` and returns `invalid_grant` (`refresh token is invalid
  or revoked`). Use this when a stale presentation should be treated as
  compromise even if it logs every client using the family out.
- **`contain`** rejects only the stale presentation, preserves the current
  successor family, emits `REFRESH_TOKEN_REUSE_CONTAINED`, and returns OAuth
  `server_error` without disclosing the successor. The retryable error tells
  Codex to reread/retry its latest authoritative credentials instead of purging
  the shared Keychain entry as it would for terminal `invalid_grant`. This
  prevents a delayed process in a shared profile fleet from causing fleet-wide
  logout, but trades automatic revocation for alert-and-investigate response.

Both events include client, policy/action, and live/revoked counts without token
material. The alert reason is:

> Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.

Wrong-client and wrong-issuer attempts are rejected without consuming the
active token, disclosing a receipt, or burning the legitimate family.

An already-stale pre-upgrade RT may have only a bare family index. That record
cannot prove its client or issuer, so gojira-mcp rejects it without revoking the
live family. This deliberately suspends reuse detection for those legacy
parents until their 31-day indexes expire; active legacy RTs still rotate and
upgrade normally.

## Webhook payload

When `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` is configured, it receives either
`REFRESH_TOKEN_REUSE` or `REFRESH_TOKEN_REUSE_CONTAINED` with the selected
policy/action. For example, a strict-policy event includes:

```json
{
  "event": "REFRESH_TOKEN_REUSE",
  "family_id": "uuid-of-family",
  "account_id": "atlassian-account-id-or-null",
  "client_id": "oauth-client-id",
  "policy": "strict",
  "action": "family_revoked",
  "reason": "Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.",
  "refresh_tokens_revoked": 1,
  "access_tokens_revoked": 2,
  "ts": "2026-08-12T14:00:00.000Z"
}
```

A contained webhook uses `event: "REFRESH_TOKEN_REUSE_CONTAINED"`,
`policy: "contain"`, `action: "family_preserved"`, zero revoked counts, and
`live_refresh_tokens` / `live_access_tokens` counts. IDs are snake_case in the
webhook; logs use `familyId`, `accountId`, and `clientId`.

Delivery has a five-second timeout. Failures are logged but cannot undo or
block the already-completed strict revocation or contained rejection.
Repeated contained presentations of the same stale RT are rejected every time;
their log/webhook signal is deduplicated for five minutes to prevent a stuck
process from flooding the alert receiver.

## Security boundary

Possession of the old RT is sufficient to claim its receipt during the tiny
window, so five seconds is a deliberate availability/security tradeoff. The
receipt is safe to return only when all of these remain true:

- the caller presents the same client ID;
- the request reaches the same gojira-mcp issuer;
- the receipt points to the immediate child generation; and
- both child credentials and the child's family membership are still live.

After five seconds, a client that lost the refresh response cannot recover from
the old parent. Under `strict` its family is burned and it must reauthenticate.
Under `contain`, the caller receives `server_error` and must reread/retry the
latest stored credential; another process that already stored the live successor
may continue. The contained event still requires investigation because the
server cannot distinguish delayed software from theft.

## What this doesn't cover

- **First use of a stolen active RT.** The first presenter wins the rotation.
  The other holder can claim the same pair for five seconds; after that, use of
  the parent burns the family under `strict` or raises a contained incident
  while leaving the attacker's successor usable under `contain`.
- **Access-token theft.** An attacker holding an AT can use it until its
  one-hour expiry or family revocation. TLS and bearer redaction remain
  essential.
- **Compromised client plus RT.** Client binding prevents cross-client leakage,
  not an attacker who has both the RT and the legitimate client identity.
- **Already-stale legacy RT.** A pre-upgrade bare family index is unbound, so it
  is rejected without family revocation. This avoids cross-instance denial of
  service at the cost of reuse detection for that parent until its index ages
  out.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GOJIRA_REFRESH_REUSE_POLICY` | `strict` | `strict` revokes the live family and returns `invalid_grant`; `contain` preserves it and returns retryable `server_error` without disclosing the successor. The split-profile Compose fleet defaults this to `contain` explicitly. |
| `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` | none | HTTP endpoint to POST strict and contained reuse events. |

The five-second replay TTL is a code-level security constant, not an operator
setting.

## See also

- [Refresh reuse — security view](../security/refresh-reuse.md)
- [Auth bridge](auth-bridge.md) — the full token dance
- [Redis schema](../reference/redis-schema.md)

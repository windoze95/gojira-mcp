# Refresh-token rotation with bounded idempotency and reuse detection

gojira-mcp rotates every MCP-issued refresh token (RT) on exchange. A
legitimate duplicate refresh gets one fixed five-second recovery window; a
stale replay outside that boundary revokes the whole token family.

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
3. **Stale parent RT:** compare the structured family index, enumerate the
   live family, and delete every current AT, RT, and family set in the same Lua
   transition.
4. **Changed record:** return `retry`; the provider rereads immutable state and
   retries at most three times.

Because Redis runs the script atomically, concurrent rotation and stale-reuse
requests cannot resurrect a family. They are serialized into either one live
successor pair or a fully revoked family.

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

The Lua transition burns all current ATs and RTs in the family before the
provider emits `REFRESH_TOKEN_REUSE` and returns
`invalid_grant` (`refresh token is invalid or revoked`). The alert reason is:

> Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.

Wrong-client and wrong-issuer attempts are rejected without consuming the
active token, disclosing a receipt, or burning the legitimate family.

An already-stale pre-upgrade RT may have only a bare family index. That record
cannot prove its client or issuer, so gojira-mcp rejects it without revoking the
live family. This deliberately suspends reuse detection for those legacy
parents until their 31-day indexes expire; active legacy RTs still rotate and
upgrade normally.

## Webhook payload

When `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` is configured:

```json
{
  "event": "REFRESH_TOKEN_REUSE",
  "family_id": "uuid-of-family",
  "account_id": "atlassian-account-id-or-null",
  "reason": "Refresh token reuse: replay fell outside the idempotency window or its immediate successor was no longer live.",
  "refresh_tokens_revoked": 1,
  "access_tokens_revoked": 2,
  "ts": "2026-08-12T14:00:00.000Z"
}
```

Delivery has a five-second timeout. Failures are logged but cannot undo or
block the already-completed revocation.

## Security boundary

Possession of the old RT is sufficient to claim its receipt during the tiny
window, so five seconds is a deliberate availability/security tradeoff. The
receipt is safe to return only when all of these remain true:

- the caller presents the same client ID;
- the request reaches the same gojira-mcp issuer;
- the receipt points to the immediate child generation; and
- both child credentials and the child's family membership are still live.

After five seconds, the conservative theft response is restored. A client that
lost the refresh response can recover by retrying promptly; a later retry must
reauthenticate after the family is burned.

## What this doesn't cover

- **First use of a stolen active RT.** The first presenter wins the rotation.
  The other holder can claim the same pair for five seconds; after that, use of
  the parent burns the family.
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
| `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` | none | HTTP endpoint to POST `REFRESH_TOKEN_REUSE` events. |

The five-second replay TTL is a code-level security constant, not an operator
setting.

## See also

- [Refresh reuse — security view](../security/refresh-reuse.md)
- [Auth bridge](auth-bridge.md) — the full token dance
- [Redis schema](../reference/redis-schema.md)

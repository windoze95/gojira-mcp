# Refresh-token rotation with reuse detection

gojira-mcp rotates the MCP-issued refresh token on every exchange and
detects replay of a previously rotated-away RT.

The threat: an attacker exfiltrates an RT, the legitimate client also has
the RT, both try to use it. With non-rotating RTs both succeed and the
theft is invisible. With rotation + reuse detection the second use of a
no-longer-valid RT triggers full-family revocation and a structured audit
event.

## Family layout

Every RT belongs to a **family**:

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `mcp_refresh:<rt>` | String (JSON) | 30 days | Active RT; includes `familyId`, `generation` |
| `rt_family:<rt>` | String | 31 days | Per-RT pointer to its family (outlives the RT) |
| `refresh_family:<familyId>` | Set | 30 days | All currently-live RTs in the family |
| `refresh_family_tokens:<familyId>` | Set | 30 days | All currently-live ATs in the family |

The 31-day TTL on `rt_family:<rt>` is the critical bit — it lets us
identify the family of a stale RT for a ~1-day grace window after the RT
itself has been DELed. Without it we'd lose the ability to detect reuse
shortly after rotation.

## Normal rotation

```
client → POST /token  grant_type=refresh_token  refresh_token=<rt1>
   │
   ▼
provider.exchangeRefreshToken(client, rt1):
   - GET mcp_refresh:<rt1>  → { accountId, clientId, scopes, familyId, generation:N }
   - verify clientId
   - verify upstream token:<accountId> still exists (else burn rt1 and 401)
   - mint AT/RT, generation N+1, **same familyId**
   - persist new mcp_refresh:<rt2>, rt_family:<rt2>, family set membership
   - DEL mcp_refresh:<rt1>   (rt_family:<rt1> stays alive for grace window)
   - SREM refresh_family:<familyId> rt1
   ◄─ { access_token: at2, refresh_token: rt2, ... }
```

## Reuse detection

```
attacker → POST /token  grant_type=refresh_token  refresh_token=<rt1>  (stale)
   │
   ▼
provider.exchangeRefreshToken:
   - GET mcp_refresh:<rt1>   → nil   (rotated away)
   - GET rt_family:<rt1>     → familyId      (still in grace window)
   - SCARD refresh_family:<familyId> > 0    (rt2 is still alive)
   - REUSE DETECTED:
     - destroyFamily(familyId):
         pipeline DEL mcp_refresh:* for every RT in the family
         pipeline DEL mcp_token:*    for every AT in the family
         pipeline DEL refresh_family:<familyId>
         pipeline DEL refresh_family_tokens:<familyId>
     - logger.warn({ event: "REFRESH_TOKEN_REUSE", familyId,
                     refresh_tokens_revoked, access_tokens_revoked })
     - if GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK: POST to that URL
   - throw InvalidGrantError("refresh token is invalid or revoked")
```

After this, both attacker and legitimate client see `invalid_grant` on
their next `/token` call. The legitimate user re-authenticates via
`/authorize`, getting a fresh family. The attacker's stolen RT is dead.

## Webhook payload

When `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` is configured:

```json
{
  "event": "REFRESH_TOKEN_REUSE",
  "family_id": "uuid-of-family",
  "account_id": "atlassian-account-id-or-null",
  "reason": "Refresh token reuse: presented previously-rotated RT while family still has live members.",
  "refresh_tokens_revoked": 1,
  "access_tokens_revoked": 1,
  "ts": "2026-05-11T16:00:00.000Z"
}
```

Use a 5-second timeout; failures are logged but don't block the
revocation path. Plumb this into PagerDuty, Slack, or SIEM.

## Why the 31-day grace TTL

If an RT expires naturally at day 30 without being rotated (e.g., user
goes on vacation), the family-index sticks around for one extra day. A
replay attempt during that grace window still detects reuse correctly.
After day 31 the family-index expires too, and the system has no memory
of that RT — which is fine because the legitimate RT can no longer
authenticate either.

## What this doesn't cover

- **Replay of a still-valid RT.** If the attacker captures and the
  legitimate client hasn't yet rotated, the attacker wins this round.
  Reuse detection triggers on the *second* presentation of a now-invalid
  RT, not on stolen-but-still-valid use. That's where the access-token
  TTL (1h) and short-lived nature of MCP sessions matter.
- **Lost legitimate clients.** If a user's device crashes mid-rotation
  (got the new pair, lost it before storing), they replay the old RT,
  trigger reuse, and have to re-auth. Annoying but correct.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` | none | HTTP endpoint to POST `REFRESH_TOKEN_REUSE` events |

## See also

- [Refresh reuse — security view](../security/refresh-reuse.md)
- [Auth bridge](auth-bridge.md) — the full token dance
- [Redis schema](../reference/redis-schema.md)

# Refresh-token reuse detection

When gojira-mcp's refresh-token rotation flow sees a previously-rotated
RT presented again, it treats it as a **theft signal** and burns the
entire token family.

For the mechanics, see
[refresh-token-rotation.md](../architecture/refresh-token-rotation.md).
This page focuses on the security implications, the audit channel, and
the incident-response playbook.

## What it means

The legitimate client should never replay an old RT — it received a new
one in response to its last refresh and should be using that. A replay
implies one of:

1. **Theft.** Attacker captured the RT (e.g., from an exposed env file,
   a logging accident, a compromised endpoint) and tried to use it.
2. **Client bug.** Some clients re-try with the old RT on transient
   failures. This is a client bug worth fixing but presents identically
   to theft.
3. **Race.** The legitimate client got the new pair but failed to store
   it (crash mid-write), and retried with the old. Rare but real.

The server cannot distinguish these cases at detection time. The
conservative response — burn the family — is right for case 1, annoying
but recoverable for cases 2 and 3.

## What gets burned

```
destroyFamily(familyId):
  pipeline DEL mcp_refresh:* for every RT in refresh_family:<familyId>
  pipeline DEL mcp_token:*    for every AT in refresh_family_tokens:<familyId>
  pipeline DEL refresh_family:<familyId>
  pipeline DEL refresh_family_tokens:<familyId>
```

After this:

- Every live session derived from this family fails its next
  `/mcp` call with `invalid_grant`.
- Every refresh attempt — by attacker or legitimate client — gets
  `invalid_grant`.
- The user must re-authenticate via `/authorize` to get a fresh family.
- Upstream Atlassian credentials at `token:<accountId>` are
  **not** touched — only the gojira-side bearer family.

## Audit event

A `warn`-level pino log line:

```json
{
  "event": "REFRESH_TOKEN_REUSE",
  "familyId": "...",
  "accountId": "...",
  "reason": "Refresh token reuse: presented previously-rotated RT while family still has live members.",
  "refresh_tokens_revoked": 1,
  "access_tokens_revoked": 1
}
```

If `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` is configured, a POST is also
made to that URL with the same shape plus a `ts` field. 5-second
timeout; webhook failures are logged but don't block revocation.

Wire the webhook to:

- A SIEM that paginates over reuse events for incident triage
- A Slack/PagerDuty channel that alerts a human
- An internal incident-tracking system

## Why it works

Rotation alone (without reuse detection) doesn't help — the attacker
replaying a still-valid RT just gets a working bearer.

Rotation **plus** reuse detection works because:

- After legitimate rotation, the old RT is *gone* on the server.
- An attacker replaying the old RT triggers the missing-but-family-exists
  branch.
- The 31-day TTL on `rt_family:<rt>` (one day longer than the RT itself)
  ensures the family lookup still works during the grace window.

The window the attacker has to use a freshly-stolen RT *before* the
legitimate client rotates is unavoidable. Keep it small by:

- Short MCP access-token TTL (1 hour). Clients refresh frequently.
- Per-call audit logging — even an "unused" stolen RT eventually leaves
  a trace if it tries to refresh.

## Limitations

- **First-use stolen.** If the attacker captures and uses the RT *before*
  the legitimate client refreshes, the attacker rotates the family.
  The legitimate client then tries the old RT next, triggers reuse, and
  the family burns. Net result: both attacker and victim are kicked out,
  victim has to re-auth. Outcome is correct but the attacker had a
  window of (up to) 1 hour with an AT.
- **Sustained interleaving.** A patient attacker who rotates exactly in
  sync with the legitimate client could keep the family alive indefinitely.
  Defence: per-bearer access logs surface anomalies (geographically
  distant origins, different user agents); make sure your SIEM
  correlates `actor.account_id` against IP/UA across bearer issuances.
- **Same-session theft.** If the attacker is on the same network and can
  capture the bearer at the transport layer, RT rotation doesn't help —
  they have the AT directly and can act with it for up to an hour.
  Mitigation: TLS, never log bearers, isolate operator hosts.

## Incident-response playbook

When you see a `REFRESH_TOKEN_REUSE` event:

1. **Identify the user.** `accountId` from the event → look up name +
   email via the audit log of recent `gojira.whoami` calls or the
   StoredToken (operator query in Redis).
2. **Estimate the window.** Find the `family_id`'s creation time from
   the audit trail (look for the first `tool_call` from this
   account_id with a matching bearer). The window is from then to now.
3. **Enumerate damage.** Filter the audit log for tool calls by this
   `account_id` in the window. Any `outcome:"success"` is a candidate
   action by an attacker.
4. **Pivot via journal.** For destructive successes, look up the
   `operation_id` in the journal (`gojira.listRecentOperations` /
   `gojira.getOperation`) to see exact before/after snapshots.
5. **Revert reversible damage.** Use `gojira.revertOperation(op_id,
   commit:true)` for each reversible op.
6. **Notify the user.** They need to revoke any Atlassian app grants
   they don't recognize, rotate their Atlassian password, and re-auth
   to gojira-mcp.
7. **Hunt for source.** Check operator hosts, logs, and any place an
   RT might have been captured. Common: dev environment with debugging
   on, plaintext env file in a shared drive, captured via a
   man-in-the-middle on a misconfigured proxy.

## See also

- [Refresh-token rotation (architecture)](../architecture/refresh-token-rotation.md)
- [Audit trail](audit-trail.md)
- [Incident response](../operations/incident-response.md)
- [Threat model](threat-model.md)

# Site pinning

Each gojira-mcp deployment is pinned to a single Atlassian cloud site at
deploy time via `ATLASSIAN_PINNED_CLOUD_ID`. When set, any tool invocation
whose resolved cloudId differs from the pinned value is refused.

This prevents a calling user with grants on multiple cloud sites (e.g.
prod + sandbox) from reaching the wrong tenant through this instance.

## Why a deploy-time floor

Per-call cloudId is too easy to spoof or confuse:

- The bearer's `accessible_cloud_ids` list comes from Atlassian's
  accessible-resources endpoint and is not a security boundary on its own —
  it's a list of *available* tenants, not "tenants this caller intended to
  use right now".
- A tool that asks the caller to provide a `cloudId` argument is asking
  the wrong question — the answer depends on intent, which the model may
  get wrong.
- An organization typically deploys one gojira-mcp instance per
  environment (prod, sandbox). Pinning encodes that operator intent.

## Enforcement points

There are three layers, in order of precedence:

1. **At /authorize / callback** — when `ATLASSIAN_PINNED_CLOUD_ID` is set,
   the upstream callback verifies the pinned id appears in the caller's
   `accessible-resources` list. If not, the flow fails with
   `error=invalid_grant&error_description=No+access+to+the+pinned+cloud+id`
   redirected back to the MCP client's `redirect_uri`. The user never
   gets a bearer for this instance.

2. **At session token mint** — the stored token has both
   `accessible_cloud_ids[]` and `primary_cloud_id`; the latter is the
   pinned id when pinning is enabled.

3. **At every tool call** — `resolveCloudId` in `wrapHandler.ts`:
   - if pinned: return pinned, after verifying it's still in
     `accessible_cloud_ids` (purges stale grants)
   - if not pinned: return `primary_cloud_id`
   - reject if API-token side-channel is bound to a different cloudId

## API-token coupling

`gojira.bindApiToken(email, token, site_url, cloud_id?)` validates the
caller's API token against `<site>.atlassian.net/rest/api/3/myself`. If
`ATLASSIAN_PINNED_CLOUD_ID` is set and the caller supplies a `cloud_id`,
they must match — otherwise the bind fails with `VALIDATION_ERROR`.

At call time, JSM/Assets tools (api-token-method) re-verify that the bound
API token's `cloud_id` matches the pinned id. Mismatch → `INSUFFICIENT_PERMISSIONS`.

## Multi-site

For an org running both prod and sandbox: deploy **two gojira-mcp
instances**, each pinned to its own cloudId, behind different hostnames
and ports. The OAuth client registration in the Atlassian developer
console can be shared, but the operator should provision separate
`ATLASSIAN_OAUTH_CLIENT_ID` values to keep audit and revocation
independent.

A single instance unpinned (omit `ATLASSIAN_PINNED_CLOUD_ID`) is supported
for development and small orgs. In that mode:

- the bearer's `primary_cloud_id` is the first entry from
  `accessible-resources`
- per-call rate-limit and audit shape don't distinguish across cloudIds —
  if you want per-tenant slicing you'll need to extend
  `ratelimit:<accountId>` keys with a cloud suffix and the audit emitter
  to carry a `cloud_id` dimension

## Failure surface

| Scenario | What the caller sees |
|---|---|
| `ATLASSIAN_PINNED_CLOUD_ID` not in accessible-resources at callback time | OAuth redirect with `error=invalid_grant` |
| API token bound to a different cloudId | `INSUFFICIENT_PERMISSIONS` with `details.api_token_cloud_id` |
| Pinned cloudId no longer accessible (grant revoked upstream) | `INSUFFICIENT_PERMISSIONS` at next call |
| No cloudId resolvable at all (no OAuth, no API token, no pin) | `VALIDATION_ERROR` with hint to re-auth or bind |

## See also

- [Auth bridge](auth-bridge.md)
- [Environment variables](../deployment/environment-variables.md) — the
  `ATLASSIAN_PINNED_CLOUD_ID` row
- [`gojira.bindApiToken`](../tools/utility.md)

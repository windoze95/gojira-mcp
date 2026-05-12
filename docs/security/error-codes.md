# Error codes

The full taxonomy of tool error codes, with the conditions that produce
each and the recommended caller response.

## Envelope

```json
{
  "success": false,
  "error": {
    "code": "<one of below>",
    "message": "<human readable>",
    "details": {},
    "reference_id": "<uuid>"
  }
}
```

`reference_id` correlates the envelope to a server-side log line. Keep
it; cite it in operator queries.

## Codes

### `AUTH_REQUIRED`

The caller has no valid bearer, or the bearer lacks the credential
needed for this tool.

| Scenario | `details` |
|---|---|
| No `Authorization` header | n/a — fails at middleware, not at tool dispatch |
| Bearer carries no `accountId` (impossible in normal flow) | empty |
| API-token tool but no API token bound | `{ auth_method: "api_token", bind_tool: "gojira.bindApiToken" }` |

**Caller action:** walk the OAuth flow, then for API-token tools call
`gojira.bindApiToken`.

### `AUTH_EXPIRED`

Atlassian rejected the credential with 401, or our refresh attempt
failed (400/401 from the refresh endpoint).

`details` carries the upstream error messages.

**Caller action:** re-authenticate from scratch (`/authorize`). The
existing refresh token is dead.

### `INSUFFICIENT_PERMISSIONS`

The caller is identified but doesn't have what's needed.

| Scenario | `details` |
|---|---|
| Tool's group not listed in `GOJIRA_ENABLED_GROUPS` | n/a |
| `admin_org` tool without `GOJIRA_ENABLE_ORG_ADMIN=true` | n/a |
| `admin_org` tool but caller is not in the org admin list | `{ hint: "Org admin tools require the caller's accountId to appear in /admin/v1/orgs/<orgId>/users?role=admin" }` |
| Site pinning mismatch (cloudId not accessible) | `{ pinned: "...", accessible: [...] }` |
| API token bound to a different cloudId than pinned | `{ pinned: "...", api_token_cloud_id: "..." }` |
| Atlassian 403 with "permission" in body | `{ upstream: [...] }` |

**Caller action:** request the right scopes at `/authorize`, or have the
caller's permissions escalated. For pinning errors, use the correctly
pinned instance for that cloud.

### `NOT_FOUND`

The targeted resource doesn't exist (404 from Atlassian, or 410 Gone,
or an unknown journal opId).

**Caller action:** verify the id/key.

### `VALIDATION_ERROR`

The input doesn't conform to what the upstream — or our schema —
expects. This is the bucket for client-fixable errors.

| Scenario | `details` |
|---|---|
| Local zod parse failure | path + reason from zod |
| 400 from Atlassian with structured `errors` object | `{ upstream: [...], fieldErrors: { field: "msg" } }` |
| 409 conflict | `{ upstream: [...], conflict: true }` |
| Bad cloudId resolution | `{ message: "No cloudId could be resolved..." }` |
| API token bind: accountId mismatch | `{ oauth_account_id, token_account_id }` |

**Caller action:** correct the input.

### `RATE_LIMITED`

Either the local per-user bucket is empty, or Atlassian returned 429
after the retry layer exhausted its attempts.

| Scenario | `details` |
|---|---|
| Local bucket exhausted | `{ soft_capped: bool, tokens: number }` |
| Atlassian 429 after retries | `{ retry_after_ms, reset_unix }` |

**Caller action:** back off. Honour the `retry_after_ms` hint if
present.

### `UPSTREAM_UNAVAILABLE`

Atlassian returned 5xx after the retry layer exhausted, or the network
was unreachable.

**Caller action:** retry later. Persistent failures should escalate to
operator triage — Atlassian status page first, then logs.

### `UNEXPECTED_ERROR`

The catch-all. Anything not covered above — programming errors,
unexpected response shapes, third-party library exceptions.

The envelope includes the `reference_id`; the full exception (including
stack) is logged at error level with the same id.

**Caller action:** cite the `reference_id` to operators; retry once if
the action is idempotent.

## Mapping summary (upstream → code)

| Upstream | gojira code |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 (after refresh attempt) | `AUTH_EXPIRED` |
| 403 (general) | `INSUFFICIENT_PERMISSIONS` |
| 403 (admin_org context) | `INSUFFICIENT_PERMISSIONS` with org-admin hint |
| 404, 410 | `NOT_FOUND` |
| 409 | `VALIDATION_ERROR` with `conflict: true` |
| 429 (after retries) | `RATE_LIMITED` |
| 5xx (after retries) | `UPSTREAM_UNAVAILABLE` |
| Network error (ECONNRESET, ETIMEDOUT, etc.) | `UPSTREAM_UNAVAILABLE` |
| Anything else | `UNEXPECTED_ERROR` |

## Retry-after handling

`withRetry` in `src/atlassian/retry.ts` honours these inputs (whichever
is largest):

- Computed backoff: `initialDelayMs * 2^attempt + 0..20% jitter`,
  capped at `maxDelayMs`.
- `Retry-After` header (seconds or HTTP-date).
- `AtlassianApiError.retryAfterMs` from the parsed response.

Defaults: 3 retries, 500 ms initial, 30 s cap, multiplier 2.

## See also

- [Error model (architecture)](../architecture/error-model.md)
- [Audit trail](audit-trail.md) — what gets logged with each error

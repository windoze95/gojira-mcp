# Error model

Every tool returns one of two shapes:

```ts
// success
{ success: true, result: ... }

// failure
{
  success: false,
  error: {
    code: ErrorCode,
    message: string,
    details?: unknown,
    reference_id: string   // UUID, logged alongside the underlying exception
  }
}
```

The success/failure envelope is JSON-encoded into the MCP `CallToolResult`:

```ts
{
  content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  isError?: true     // present only on failure
}
```

## Error codes

| Code | When | Caller action |
|---|---|---|
| `AUTH_REQUIRED` | No bearer, or bearer carries no `accountId`, or required side-channel (API token) not bound. | Walk the OAuth flow; call `gojira.bindApiToken` if needed. |
| `AUTH_EXPIRED` | The stored upstream credential has no RT, Atlassian explicitly returned OAuth `invalid_grant` for the current RT, or an API call still returned 401 after refresh had its chance. | Re-authenticate via `/authorize`. |
| `INSUFFICIENT_PERMISSIONS` | 403 from Atlassian; pinned cloudId not accessible; org-admin verification failed; deployment has the group disabled. | Verify access, or escalate. |
| `NOT_FOUND` | 404 from Atlassian; journal lookup for an unknown opId. | Verify the id. |
| `VALIDATION_ERROR` | 400 from Atlassian (with field-level details); 409 conflict; local zod failures; bad cloudId; missing `commit:true`-required flag (rare). | Fix the input. |
| `RATE_LIMITED` | Local bucket exhausted, or 429 from Atlassian after retry exhaustion. | Back off. |
| `UPSTREAM_UNAVAILABLE` | 5xx/network failure; refresh lock contention; or a refresh failure other than proven `invalid_grant` (including `invalid_client`). The stored credential is preserved. | Retry later; escalate persistent failures. |
| `UNEXPECTED_ERROR` | Anything not covered above (programming errors, unexpected response shapes, or a preserved encrypted credential that cannot be decoded safely). | Cite `reference_id` to operators. |

## reference_id

Every error envelope carries a UUID `reference_id`. The same UUID is
logged with `logger.error`/`warn` at the time the error was created, with
the underlying exception and stack. A user-facing message like
*"An unexpected error occurred. Reference ID: 7f3e..."* can be
cross-referenced to server logs by an operator.

## Mapping upstream → ToolError

`mapAtlassianError(err, opts)` in `src/atlassian/errors.ts`:

```
401  → AUTH_EXPIRED                  (refresh already had its chance)
403  → INSUFFICIENT_PERMISSIONS
        opts.adminOrg=true adds a "Caller is not an organization admin" hint
404  → NOT_FOUND
410  → NOT_FOUND
400  → VALIDATION_ERROR (with fieldErrors if the body has an `errors` object)
409  → VALIDATION_ERROR (with conflict: true)
429  → RATE_LIMITED (carries retry_after_ms, reset_unix)
5xx  → UPSTREAM_UNAVAILABLE
0    → UPSTREAM_UNAVAILABLE  (network unreachable)
else → UNEXPECTED_ERROR
```

The upstream **refresh endpoint** is classified more narrowly than ordinary API
responses. A missing RT or an OAuth `invalid_grant` for the unchanged stored
snapshot produces `AUTH_EXPIRED`; only that proven-dead snapshot is deleted.
`invalid_client`, other OAuth errors, 5xx, network failures, and distributed-lock
contention produce `UPSTREAM_UNAVAILABLE` and preserve the encrypted credential
for retry. If a concurrent login replaced the snapshot, compare-and-swap guards
prevent the older refresh response from overwriting or deleting it.

The mapper extracts upstream messages from common Atlassian shapes:

- Jira: `{ errorMessages: [...] }` and `{ errors: { field: "msg" } }`
- Confluence: `{ message }`
- admin.atlassian.com: `{ errors: [{ title, detail }] }`
- Some endpoints: `{ fault: { faultstring } }`

## Tool wrapper integration

`wrapHandler` enforces the envelope:

- A tool throwing `ToolError` (or any subclass) has its `toEnvelope()`
  serialized.
- A tool throwing a raw `Error` becomes `UNEXPECTED_ERROR` with a fresh
  `reference_id` and the original message + stack logged.
- A tool returning a value that has `dry_run: true` (from
  `buildDryRunIfNotCommitted`) is audited as `outcome: "dry_run"` but
  the envelope is still the success shape — dry-run is not an error.

## Failure-mode philosophy

| Subsystem | Failure stance |
|---|---|
| Identity / auth | **Fail closed** — no path allows tool dispatch without a verified bearer. |
| Rate limiter | **Fail open** — Redis errors return `allowed=true` and a warn log. |
| Audit sink | **Fail open** — write failures log a warn and continue. |
| Journal | **Fail closed for writes** — if the journal write fails inside `journalOp`, the original error still propagates and the entry is half-written; live with that. (TODO: stronger atomicity.) |
| Operator floor | **Fail closed** — disabled groups never register, never dispatch. |

## See also

- [Audit trail](../security/audit-trail.md) — what gets logged alongside
  `reference_id`
- [Error codes (security view)](../security/error-codes.md)
- `src/middleware/errorHandler.ts`
- `src/atlassian/errors.ts`

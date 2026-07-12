# HTTP routes

Every route mounted by gojira-mcp, with auth requirements and behaviour.

## Public (unauthenticated)

| Route | Method | Behaviour |
|---|---|---|
| `/health` | GET | Liveness + Redis ping. Returns 200 with JSON when healthy, 503 when Redis is unreachable. |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 OAuth metadata: issuer, authorization/token/registration/revocation endpoints, supported scopes, etc. |
| `/.well-known/oauth-protected-resource` | GET | RFC 9728 protected-resource metadata if requested by the client. |

## OAuth Authorization Server (mounted by `mcpAuthRouter`)

| Route | Method | Auth | Behaviour |
|---|---|---|---|
| `/register` | POST | none | RFC 7591 dynamic client registration. Returns `{ client_id, client_secret, ... }` with 90-day expiry. |
| `/authorize` | GET | none | Begin the OAuth flow. Accepts `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `state`, `response_type=code`, `scope`. Persists pending state, redirects to Atlassian. |
| `/token` | POST | client_secret_basic / post | Exchange `authorization_code` or `refresh_token` for an MCP bearer. Validates PKCE (server-side) and client identity. |
| `/revoke` | POST | client-scoped | Revoke an AT or RT. Verifies the calling client owns the token. |

## Upstream callback

| Route | Method | Auth | Behaviour |
|---|---|---|---|
| `/oauth/atlassian-callback` | GET | one-time CSRF state | Receives Atlassian's `?code=&state=` redirect. Exchanges the code, calls `/me` and `/accessible-resources`, persists the StoredToken, mints our own auth code, redirects back to the MCP client's `redirect_uri`. Errors propagate as `?error=&error_description=` to the client. |

## MCP transport

| Route | Method | Auth | Behaviour |
|---|---|---|---|
| `/mcp` | POST | `requireBearerAuth` | StreamableHTTP RPC. Without an `Mcp-Session-Id` header creates a new session; with one routes to the existing session. |
| `/mcp` | GET | `requireBearerAuth` | SSE stream for server-initiated notifications on the existing session. |
| `/mcp` | DELETE | `requireBearerAuth` | Close and clean up the session. |

## Express middleware order

```
1. helmet()                      — secure default headers (HSTS, X-Frame-Options, etc.)
2. cors({ origin })              — ALLOWED_ORIGINS allowlist; '*' permitted (credentials off when '*')
3. express.json({ limit: 1mb })
4. express.urlencoded({ ... })
5. GET /health                   — terminates the chain; never reaches /mcp routes
6. mcpAuthRouter({ ... })        — discovery, /register, /authorize, /token, /revoke
7. /oauth/atlassian-callback router
8. requireBearerAuth({ ... })    — applied only to /mcp paths
9. /mcp POST/GET/DELETE handlers
10. error handler                — last; logs and 500s on uncaught
```

## CORS

`ALLOWED_ORIGINS` (env var) gates every route subject to CORS. Accepts:

- `*` — any origin allowed (suitable for dev or unauthenticated routes;
  bearer auth still gates `/mcp`)
- comma-separated list of exact origin strings — case-sensitive matches

`credentials` is **conditional** on that value (`src/server.ts`): it is
`true` for an explicit origin allowlist, and `false` whenever
`ALLOWED_ORIGINS` contains `*` — a wildcard origin with credentials is
rejected by browsers anyway, so the server never advertises the
combination. Either way gojira-mcp never reads or sets a cookie; `/mcp`
is gated by the `Authorization` bearer.

## Error responses

| Path family | Error shape |
|---|---|
| `/health` | `{ status: "degraded", redis: "fail", ... }` with HTTP 503. |
| `/.well-known/*` | Static JSON; SDK-controlled. |
| `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1 error responses: `{ error, error_description, error_uri? }`. |
| `/oauth/atlassian-callback` | 302 back to the MCP client's redirect_uri with `?error=&error_description=`, never JSON. |
| `/mcp` | StreamableHTTP returns whatever the SDK encodes for the session; tool errors return as `CallToolResult { content, isError: true }` with the JSON envelope inside the text content. |
| All other paths | 404 from express default. |

## Path conventions

- All routes are case-sensitive.
- No trailing slash redirects.
- No path-versioning — there's only one version.
- The `/oauth/` prefix is reserved for the Atlassian callback; do not
  add other routes under it.

## See also

- [Auth bridge](../architecture/auth-bridge.md)
- [Session lifecycle](../architecture/session-lifecycle.md)
- [Health checks](../deployment/health-checks.md)

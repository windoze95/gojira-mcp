# Auth bridge

gojira-mcp implements a **dual-leg OAuth bridge**:

- to MCP clients it is an **OAuth 2.1 Authorization Server**, issuing opaque
  bearer tokens;
- to Atlassian it is an **OAuth 2.0 Client**, walking the 3LO consent flow
  to obtain per-user delegated credentials.

MCP clients never see Atlassian tokens. Atlassian never sees the MCP-issued
bearer. Identity is bound end-to-end: the bearer's `accountId` extra-claim
came from `/me` called with that user's own Atlassian access token.

## Roles

| Side | gojira-mcp's role | Implementation |
|---|---|---|
| MCP client ↔ gojira-mcp | Authorization Server | `GojiraOAuthProvider` implementing the SDK's `OAuthServerProvider` |
| gojira-mcp ↔ Atlassian | OAuth Client | `oauthCallback.ts` + `atlassian/identity.ts` + `tokenRefresh.ts` |

## Endpoints

Mounted by `mcpAuthRouter` from the SDK plus the upstream callback:

| Path | Purpose | Auth |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | OAuth discovery | unauthenticated |
| `POST /register` | RFC 7591 dynamic client registration | unauthenticated; emits client_id + secret with 90-day TTL |
| `GET /authorize` | begin the flow with the MCP client's PKCE | unauthenticated; persists `pending_auth:<id>` + `atlassian_state:<state>` |
| `POST /token` | code → AT/RT exchange; refresh exchange | client_secret_basic or post |
| `POST /revoke` | revoke an AT or RT | client-scoped |
| `GET /oauth/atlassian-callback` | upstream callback (Atlassian → gojira) | one-time-use state via `GETDEL` |
| `GET /health` | liveness + Redis ping | **unauthenticated by design** |
| `POST/GET/DELETE /mcp` | MCP transport | `requireBearerAuth` |

## The full dance

```
1. MCP client → POST /register
   ─► stores OAuthClientInformationFull in oauth_client:<id> (TTL 90d)
   ◄─ returns { client_id, client_secret }

2. MCP client → GET /authorize?
       client_id, redirect_uri, code_challenge,
       code_challenge_method=S256, state, response_type=code
   provider.authorize():
     - read ATLASSIAN_OAUTH_SCOPES from config
     - generate pendingAuthId (16-byte hex), persist pending_auth:<id>
       (TTL 10 min): { clientId, codeChallenge, redirectUri, state,
                       atlassianScopes }
     - generate atlassianState (32-byte hex CSRF), persist atlassian_state:<state>
       (TTL 10 min): { pendingAuthId }
     - 302 → https://auth.atlassian.com/authorize?
                audience=api.atlassian.com&
                client_id=<server-side gojira creds>&
                scope=<union>&
                redirect_uri=ATLASSIAN_CALLBACK_URI&
                state=atlassianState&
                response_type=code&
                prompt=consent

3. user logs in on Atlassian, consents

4. Atlassian → GET /oauth/atlassian-callback?code=...&state=atlassianState
   oauthCallback handler:
     - GETDEL atlassian_state:<state> → pendingAuthId (atomic one-time)
     - GET pending_auth:<id>
     - POST https://auth.atlassian.com/oauth/token
       { grant_type=authorization_code, client_id, client_secret, code,
         redirect_uri }
       ─► { access_token, refresh_token, expires_in }
     - GET https://api.atlassian.com/me              → accountId, name, email
     - GET https://api.atlassian.com/oauth/token/accessible-resources
                                                      → array of cloudIds
     - D4 site pinning: if ATLASSIAN_PINNED_CLOUD_ID is set, verify it
       appears in the list; reject with error= on the redirect_uri otherwise
     - persist StoredToken { access_token, refresh_token, expires_at,
                             account_id, name, email,
                             accessible_cloud_ids, primary_cloud_id }
       under token:<account_id> (AES-256-GCM, 90d sliding)
     - mint our own auth code (32-byte hex), persist auth_code:<code>
       (TTL 5 min): { accountId, clientId, codeChallenge, redirectUri }
     - DELETE pending_auth:<id>
     - 302 → MCP client's redirect_uri?code=<our_code>&state=<client_state>
     - error paths: 302 with ?error=...&error_description=... preserving
       the MCP client's state — never a JSON 500 to a hung client

5. MCP client → POST /token  { grant_type=authorization_code, code,
                                code_verifier, redirect_uri, client_id,
                                client_secret }
   SDK calls our provider:
     - challengeForAuthorizationCode → returns stored code_challenge
     - SDK validates PKCE against code_verifier
     - exchangeAuthorizationCode:
         - GETDEL auth_code:<code>     (atomic one-time consume)
         - verify code.clientId == client.client_id  (RFC 6749 §4.1.3)
         - verify redirectUri matches if supplied
         - mintMcpTokens({ accountId, clientId }):
             - generate AT (32-byte hex, 1h TTL), RT (32-byte hex, 30d TTL)
             - scopes = []  (accountId travels in the bearer's `extra`)
             - persist mcp_token:<at>  → { accountId, clientId, scopes,
                                            expiresAt, familyId }
             - persist mcp_refresh:<rt> → { accountId, clientId, scopes,
                                             familyId, generation:1 }
             - persist rt_family:<rt> → familyId  (TTL 31d, outlives RT)
             - SADD refresh_family:<familyId> rt
             - SADD refresh_family_tokens:<familyId> at
     ◄─ { access_token, refresh_token, token_type:"Bearer",
          expires_in:3600, scope }

6. MCP client → POST /mcp with Authorization: Bearer <at>
   requireBearerAuth → verifyAccessToken
     - GET mcp_token:<at>
     - check expiresAt
     - return AuthInfo { token, clientId, scopes,
                         expiresAt,
                         extra: { accountId, familyId } }
   request flows into the session map / tool dispatch
```

## Identity enforcement

The bearer's `extra.accountId` is the **only** source of caller identity.
Tools never accept a caller/requester field from the client. Concrete
patterns:

- **Create operations** server-side overwrite the identity field. If a tool
  ever needs to set a `reporter` or `assignee` it must derive it from
  `ctx.accountId`, not from input.
- **Approval/ownership operations** preflight-query Atlassian with both the
  record id AND `accountId = ctx.accountId`; reject if empty.
- **Update operations** strip server-managed fields via
  `sanitizeIssueUpdate()` in `src/utils/validators.ts`. The strip list
  includes `id, key, self, created, updated, creator, status, workratio,
  lastViewed, votes, watches, subtasks, aggregateprogress, progress,
  issuetype`.

## Upstream refresh

`TokenRefresher.ensureFreshToken(accountId)` runs before every tool call
through `wrapHandler`. Logic:

1. Load the StoredToken. If `expires_at - now > 60_000` (60-second guard),
   return it.
2. Acquire `token_refresh_lock:<accountId>` via
   `SET ... <uuid> EX 10 NX`. On `nil` return:
   - sleep 1s, re-read the token; if still stale, throw `AuthExpiredError`.
3. Inside the lock: double-check (another holder may have refreshed during
   contention).
4. `POST https://auth.atlassian.com/oauth/token` with `grant_type=refresh_token`.
5. Persist the new StoredToken (preserves refresh_token if Atlassian didn't
   rotate one).
6. Release the lock via Lua **compare-and-delete** — we only DEL when the
   value still matches our UUID. Prevents a stale holder from accidentally
   releasing a newer lock.

400/401 from the refresh endpoint deletes `token:<accountId>` and throws
`AuthExpiredError` to force re-auth. The MCP refresh path notices the
missing upstream credential on its next exchange and burns the RT too.

## See also

- [Session lifecycle](session-lifecycle.md)
- [Refresh-token rotation](refresh-token-rotation.md) — *MCP-side* RT
  rotation with reuse detection (D1)
- [Site pinning](site-pinning.md) — D4 cloudId enforcement
- [OAuth flow doc](../oauth/flow.md) for the same dance as a single page with
  fewer cross-references
- [OAuth scope handling](../oauth/scope-grammar.md)

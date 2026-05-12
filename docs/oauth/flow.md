# OAuth flow

The full dual-leg dance, single page, no cross-references.

## Actors

- **MCP client** — Claude Desktop, VS Code chat, Claude Code, Cursor, etc.
- **gojira-mcp** — Authorization Server to the MCP client, OAuth Client to Atlassian.
- **Atlassian** — `auth.atlassian.com` (OAuth) and `api.atlassian.com` (identity).
- **User** — the human consenting in their browser.

## Bird's-eye

```
MCP client ───/register───► gojira-mcp                       Atlassian
            │                                                       
            │   /authorize (PKCE)                                    
            ├────────────────► gojira-mcp                            
            │                  ├─ persists pending_auth, atlassian_state
            │                  └─ 302 redirect with state            
            │                                                        
            │                                ───authorize page───►   
            │                                                        
            │                                            user logs in
            │                                                        
            │                  ◄──/oauth/atlassian-callback?code=&state=
            │                                                        
            │                  ├─ exchange code → upstream AT/RT      
            │                  ├─ GET /me                             
            │                  ├─ GET /oauth/token/accessible-resources
            │                  ├─ validate pinned cloudId             
            │                  ├─ persist token:<accountId>           
            │                  └─ mint our own code, redirect back    
            │                                                        
            ◄────302 with our code─────                              
            │                                                        
            │   /token (code + verifier)                              
            ├────────────────► gojira-mcp                            
            │                  ├─ validate PKCE                       
            │                  ├─ mint AT + RT (rotating, family-tracked)
            │                  └─ return tokens                       
            │                                                        
            │   /mcp Authorization: Bearer <at>                       
            └────────────────► gojira-mcp                            
                               ├─ verifyAccessToken                  
                               ├─ tool dispatch w/ accountId          
                               └─ upstream call to Atlassian          
```

## Detailed walkthrough

### Step 1: Client registration (RFC 7591)

The MCP client discovers the server's OAuth metadata at
`/.well-known/oauth-authorization-server`, then posts a registration:

```http
POST /register HTTP/1.1
Content-Type: application/json

{
  "redirect_uris": ["http://localhost:54321/callback"],
  "client_name": "Claude Desktop",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic"
}
```

Response:

```json
{
  "client_id": "<uuid>",
  "client_secret": "<32-byte hex>",
  "client_id_issued_at": 1715000000,
  "client_secret_expires_at": 1722776000,
  "redirect_uris": ["http://localhost:54321/callback"],
  "..."
}
```

Stored in Redis at `oauth_client:<client_id>` with a 90-day TTL.

### Step 2: Authorize (with PKCE)

```http
GET /authorize?
    response_type=code
    &client_id=<from /register>
    &redirect_uri=http://localhost:54321/callback
    &code_challenge=<S256 hash of verifier>
    &code_challenge_method=S256
    &state=<client-side random>
    &scope=  (gojira-mcp doesn't define a custom MCP-side scope grammar)
```

gojira-mcp:

1. Reads `ATLASSIAN_OAUTH_SCOPES` (the deployment-fixed Atlassian scope set,
   always including `offline_access`).
2. Generates `pendingAuthId` (16-byte hex) → persists
   `pending_auth:<id>` with the client's PKCE challenge, redirect_uri,
   state, and the Atlassian scope set (TTL 10 min).
4. Generates `atlassianState` (32-byte hex CSRF) → persists
   `atlassian_state:<state>` with `{ pendingAuthId }` (TTL 10 min,
   single-use via `GETDEL`).
5. Redirects the browser to:
   ```
   https://auth.atlassian.com/authorize?
       audience=api.atlassian.com
       &client_id=<gojira's own Atlassian client_id>
       &scope=<union of upstream scopes>
       &redirect_uri=<gojira's atlassian-callback>
       &state=<atlassianState>
       &response_type=code
       &prompt=consent
   ```

### Step 3: User consent

The user lands on Atlassian's login + consent page. They authenticate with
their Atlassian credentials and approve the requested scopes. Atlassian
redirects back to:

```
https://gojira.example.com/oauth/atlassian-callback?
    code=<atlassian's code>
    &state=<atlassianState>
```

If the user cancels or Atlassian errors:

```
.../oauth/atlassian-callback?error=access_denied&error_description=...
```

### Step 4: Atlassian callback

gojira-mcp's `/oauth/atlassian-callback` handler:

1. `GETDEL atlassian_state:<state>` → `{ pendingAuthId }` (atomic
   one-time read; replay fails immediately).
2. `GET pending_auth:<pendingAuthId>` (still alive within its 10-min TTL).
3. If `error=` query is present: 302 back to the MCP client's redirect_uri
   with the same error params, preserving the client's `state`.
4. Otherwise: exchange the code:
   ```http
   POST https://auth.atlassian.com/oauth/token
   Content-Type: application/json

   {
     "grant_type": "authorization_code",
     "client_id": "<gojira's atlassian client_id>",
     "client_secret": "<gojira's atlassian client_secret>",
     "code": "<atlassian's code>",
     "redirect_uri": "<gojira's atlassian-callback>"
   }
   ```
   Response: `{ access_token, refresh_token, expires_in, token_type, scope }`.
5. `GET https://api.atlassian.com/me` with the new AT → `{ account_id, name, email }`.
6. `GET https://api.atlassian.com/oauth/token/accessible-resources` →
   `[{ id (cloudId), name, scopes, url, avatarUrl }]`.
7. **Site pinning check.** If `ATLASSIAN_PINNED_CLOUD_ID` is set and is not
   in the accessible list, fail with `invalid_grant` redirected back.
8. Persist the StoredToken:
   ```
   token:<accountId> = AES-256-GCM encrypted JSON of:
       {
         access_token, refresh_token, expires_at,
         account_id, name, email,
         accessible_cloud_ids[], primary_cloud_id
       }
   TTL: 90 days (sliding)
   ```
9. Mint **our** auth code (32-byte hex), persist `auth_code:<code>` with
   `{ accountId, clientId, codeChallenge, redirectUri }` (TTL 5 min).
10. DEL `pending_auth:<pendingAuthId>`.
11. 302 back to the MCP client's redirect_uri with our code + the client's state:
    ```
    http://localhost:54321/callback?code=<our-code>&state=<client-state>
    ```

### Step 5: Token exchange (MCP-side)

The MCP client `POST /token`:

```http
POST /token HTTP/1.1
Authorization: Basic <base64(client_id:client_secret)>
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&
code=<our code>&
code_verifier=<original PKCE verifier>&
redirect_uri=http://localhost:54321/callback
```

The SDK's token handler validates client_secret + redirect_uri, then calls
our `challengeForAuthorizationCode` to fetch the stored code_challenge,
then validates PKCE locally. Then `exchangeAuthorizationCode`:

1. `GETDEL auth_code:<code>` (atomic one-time consume).
2. Verify `code.clientId === client.client_id` (RFC 6749 §4.1.3).
3. Verify `redirect_uri` matches if supplied.
4. `mintMcpTokens({ accountId, clientId })`:
   - new AT (32-byte hex, **1h TTL**)
   - new RT (32-byte hex, **30d TTL**)
   - new family UUID, `generation: 1`
   - bearer scopes empty (the bearer carries `accountId` in its `extra` field;
     the SDK attaches that to every tool dispatch)
   - persist `mcp_token:<at>`, `mcp_refresh:<rt>`, `rt_family:<rt>`
   - SADD `refresh_family:<familyId>` and `refresh_family_tokens:<familyId>`
5. Return `{ access_token, refresh_token, token_type: "Bearer",
              expires_in: 3600, scope }`.

### Step 6: Tool calls

Every `POST /mcp` carries `Authorization: Bearer <at>`. The
`requireBearerAuth` middleware:

1. Parses the header.
2. Calls `provider.verifyAccessToken(at)`:
   - `GET mcp_token:<at>` → `{ accountId, clientId, scopes, expiresAt, familyId }`
   - Check expiry (deletes the key and 401s if expired).
   - Return `AuthInfo { token, clientId, scopes, expiresAt, extra: { accountId, familyId } }`.
3. Attaches the AuthInfo to `req.auth`.
4. Tool dispatch reads identity from `req.auth.extra.accountId`.

### Step 7: Refresh

When the AT expires (or the client preemptively refreshes):

```http
POST /token
grant_type=refresh_token&refresh_token=<rt>&client_id=...&client_secret=...
```

Provider's `exchangeRefreshToken`:

1. `GET mcp_refresh:<rt>` — if missing, check `rt_family:<rt>` for the
   familyId and detect reuse if siblings still exist. See
   [refresh-token-rotation.md](../architecture/refresh-token-rotation.md).
2. Verify clientId.
3. Verify upstream `token:<accountId>` still exists. If not, burn the RT
   and 401 — forces a full re-auth.
4. Mint a new pair via `mintMcpTokens` with `generation+1`, same family.
6. DEL the old `mcp_refresh:<rt>` (the `rt_family:<rt>` index lives 31d for
   reuse-detection grace).
7. Return the new tokens.

### Step 8: Revoke

```http
POST /revoke
token=<at-or-rt>
```

Provider's `revokeToken` looks up the token under both `mcp_token:` and
`mcp_refresh:` keys, verifies the calling `client_id` owns it, then DELs
it (and SREMs from the family set for RTs). No effect on the upstream
Atlassian credential — the user remains consented at Atlassian until they
revoke the gojira app from their Atlassian profile.

## See also

- [OAuth scope handling](scope-grammar.md)
- [API token side-channel](api-token-side-channel.md) — for JSM/Assets
- [Org-admin token](org-admin-token.md) — separate-credential isolation
- [Refresh-token rotation](../architecture/refresh-token-rotation.md) —
  reuse detection mechanics

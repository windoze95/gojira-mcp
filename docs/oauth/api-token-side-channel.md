# API token side-channel

Some Atlassian admin endpoints do not accept OAuth tokens — JSM admin
APIs and certain Bitbucket endpoints in particular. gojira-mcp supports
**per-user API tokens** as a side-channel for tools that require them.

## Why a side-channel

Atlassian has been progressively expanding OAuth coverage but at the
time of writing:

- **JSM admin** (request types, queues, SLAs, forms, portals, KB
  linking, organizations) → API-token-only
- **Assets/Insight API** (`api.atlassian.com/jsm/assets/workspace/...`)
  → accepts OAuth bearer for some routes, API-token for others;
  workspace discovery requires OAuth
- **Bitbucket admin** → mostly API-token

A user generates an API token at `id.atlassian.com/manage-profile/security/api-tokens`,
then binds it via the gojira `gojira.bindApiToken` tool. The token is
stored encrypted at rest, separate from the OAuth StoredToken.

## Storage

| Key | Type | TTL | Encryption |
|---|---|---|---|
| `apitoken:<accountId>` | String | None (manual revoke only) | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` |

Stored payload:

```ts
interface StoredApiToken {
  account_id: string;
  email: string;
  token: string;
  cloud_id: string | null;
  site_url: string | null;   // e.g. "acme.atlassian.net"
  display_name: string | null;
  added_at: number;
}
```

## Binding flow

```
client → tools/call gojira.bindApiToken
   { email, token, site_url, cloud_id? }
   │
   ▼
handler:
  1. If ATLASSIAN_PINNED_CLOUD_ID set AND input.cloud_id supplied:
       require they match → else VALIDATION_ERROR
  2. Build Basic auth: base64("<email>:<token>")
  3. GET https://<site_url>/rest/api/3/myself
       with Authorization: Basic ...
       → must return 200 with { accountId, displayName }
       → 401/403 maps to VALIDATION_ERROR("Atlassian rejected the API token")
  4. Verify response.accountId === ctx.accountId (the OAuth caller)
       → else VALIDATION_ERROR ("token belongs to a different user")
  5. apiTokenStore.put({ account_id, email, token, cloud_id, site_url,
                          display_name, added_at: Date.now() })
   │
   ▼
{ bound: true, display_name, cloud_id, site_url }
```

The accountId-match check (step 4) is critical: it prevents user A from
binding user B's API token to user A's gojira identity. Without that
check, the two-leg identity story would break.

## Per-call credential selection

Each `ToolDefinition` carries an `authMethod` field:

| `authMethod` | Credential source |
|---|---|
| `"none"` | No upstream credential (utility tools like `gojira.health`). |
| `"oauth"` | StoredToken's `access_token`, refreshed via `TokenRefresher`. |
| `"api_token"` | StoredApiToken — Basic auth with `email:token`. |
| `"org_admin"` | `GOJIRA_ORG_ADMIN_TOKEN` env (admin_org tools only). |

The wrapper's `resolveCredentials` and `makeClientFactories` build the
right `AtlassianClient` for the tool. The factories returned on `ctx.client`:

| Factory | Auth | Base URL |
|---|---|---|
| `ctx.client.jira()` | OAuth bearer | `api.atlassian.com/ex/jira/<cloudId>` |
| `ctx.client.confluence()` | OAuth bearer | `api.atlassian.com/ex/confluence/<cloudId>` |
| `ctx.client.apiTokenJira()` | API token Basic | `https://<site_url>` |
| `ctx.client.assets(wsId)` | OAuth bearer | `api.atlassian.com/jsm/assets/workspace/<wsId>/v1` |
| `ctx.client.admin()` | Org admin bearer | `api.atlassian.com/admin/v1` |

## Missing-token error path

A tool requiring an API token (e.g. `jsm.listServiceDesks`) when the user
hasn't bound one returns:

```json
{
  "success": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "This tool requires a per-user Atlassian API token to be bound first.",
    "details": {
      "auth_method": "api_token",
      "bind_tool": "gojira.bindApiToken"
    },
    "reference_id": "..."
  }
}
```

Clients see this and can prompt the user to bind a token before retrying.

## Pinning interaction

When `ATLASSIAN_PINNED_CLOUD_ID` is set:

- Bind-time check: if the user supplies `cloud_id`, it must match the
  pinned value. If they don't supply it, the bound token's effective
  `cloud_id` is set to the pinned value.
- Call-time check: API-token tools verify the bound token's `cloud_id`
  is the pinned value — mismatch returns `INSUFFICIENT_PERMISSIONS`.

This prevents an API token bound to a sandbox site from being used
through a prod-pinned instance.

## Revocation

There's no `gojira.unbindApiToken` tool yet. To revoke:

1. The user revokes the token at `id.atlassian.com` (immediate upstream
   invalidation).
2. The operator manually clears the Redis key:
   ```bash
   docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
       DEL apitoken:<accountId>
   ```

Adding a self-service unbind tool is a TODO; the same `authMethod: "oauth"`
handler that does bind would suffice.

## Assets workspace discovery

The Assets API root is `api.atlassian.com/jsm/assets/workspace/<workspaceId>/v1/...`.
The `workspaceId` is per-cloudId and not the same as `cloudId`. Discovery
endpoint: `GET https://api.atlassian.com/ex/jira/<cloudId>/rest/servicedeskapi/assets/workspace`.

Discovery **requires OAuth + JSM scopes**, not the API token. The Assets
tools therefore require both:

1. OAuth bearer with JSM scopes (for workspace discovery)
2. The Assets call itself can use either OAuth or API token; we use OAuth

The discovered `workspaceId` is cached for 24 hours under
`assets_workspace:<cloudId>`.

## Future: OAuth-first preference

Atlassian has signaled OAuth coverage for JSM admin is coming. When it
lands, gojira-mcp should detect and prefer OAuth — the current routing
already supports it; the per-tool `authMethod` field flips from
`"api_token"` to `"oauth"` and the same handler body works (the URL
shape is identical apart from the base).

A future `GOJIRA_TOOL_AUTH_PREFERENCE` config could let operators force
one or the other during the transition.

## See also

- [Org-admin token](org-admin-token.md) — separately gated, not
  per-user
- [Site pinning](../architecture/site-pinning.md)
- [`gojira.bindApiToken`](../tools/utility.md)

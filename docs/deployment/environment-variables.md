# Environment variables

Full reference of every variable consumed by gojira-mcp. The
authoritative source is the zod schema in `src/config.ts`; if anything
here drifts from there, the schema wins.

## Required

| Var | Notes |
|---|---|
| `ATLASSIAN_OAUTH_CLIENT_ID` | From the Atlassian developer console. The OAuth app's client id used for the upstream 3LO leg. |
| `ATLASSIAN_OAUTH_CLIENT_SECRET` | Companion secret. **Sensitive** — never log, never check in. |
| `ATLASSIAN_OAUTH_SCOPES` | Space-separated list of Atlassian OAuth scopes this deployment requests upstream. **Must include `offline_access`** (refresh tokens require it). Must be a subset of what the developer-console app declares. Only the OAuth-authed groups consume these — the JSM-admin (`jsm.*`, `forms.*`), Confluence-admin, and automation tools use the per-user API token and need no scope; Assets needs the CMDB granular scopes **plus** `read:servicedesk-request` for workspace discovery. See [turnkey-setup.md §3](turnkey-setup.md). |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded 32-byte key. Generate via `npm run generate-key`. Loader rejects any other length. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. `*` allows any origin. **Required** — no default. |
| `GOJIRA_ENABLED_GROUPS` | Comma-separated permission groups this deployment will register. **Required** — no implicit default. The value names exactly what surface is exposed (least-privilege by default). See [permission-groups.md](../tools/permission-groups.md) for the full list and per-deployment recipes. |

## OAuth / Atlassian

| Var | Default | Notes |
|---|---|---|
| `ATLASSIAN_CALLBACK_URI` | `${MCP_SERVER_URL}/oauth/atlassian-callback` | Must match a redirect URI registered on the Atlassian app. |
| `ATLASSIAN_PINNED_CLOUD_ID` | none | When set, gojira refuses any tool call whose target cloudId differs. **Strongly recommended for production.** |

## Permission-group allowlist

The primary surface-control knob — listed in the **Required** table
above. `GOJIRA_ENABLED_GROUPS` is mandatory and validated against the
known group names at startup; unknown values fail loudly.

## Org-admin gate

| Var | Default | Notes |
|---|---|---|
| `GOJIRA_ENABLE_ORG_ADMIN` | `false` | Master switch for the `admin_org` permission group. When false the group is unregistered entirely. |
| `GOJIRA_ORG_ADMIN_TOKEN` | — | Required when above is `true`. An admin.atlassian.com API token. **Sensitive.** |
| `GOJIRA_ORG_ID` | — | Required when above is `true`. The organization id. |
| `GOJIRA_ORG_ADMIN_ACCOUNT_IDS` | empty | Comma-separated Atlassian accountIds allowed to invoke `admin_org` tools. **Required (non-empty) when `GOJIRA_ENABLE_ORG_ADMIN=true`** — startup fails otherwise. Caller verification is operator-declared: there is no reliable public endpoint to enumerate an org's admins, so only accounts listed here pass the gate, and an empty list denies everyone (fails closed). |
| `GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET` | inherits main | Separate audit channel for `admin_org` ops. Strongly recommended to set explicitly. |

## Operation journal

| Var | Default | Notes |
|---|---|---|
| `GOJIRA_OPERATION_JOURNAL_TTL_DAYS` | `30` | TTL on `op_journal:*` keys and the index. |

## Usage metrics

| Var | Default | Notes |
|---|---|---|
| `GOJIRA_METRICS_TOKEN` | none | Bearer token for `GET /metrics/usage` (min 16 chars). The route is not registered when unset. Counters live in `metrics:*` Redis keys — see [Redis schema](../reference/redis-schema.md). |

## Refresh-reuse alerting

| Var | Default | Notes |
|---|---|---|
| `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` | none | HTTP endpoint POSTed when an RT reuse event is detected. Body is JSON with `family_id`, `account_id`, counts, timestamp. |

## Audit

| Var | Default | Notes |
|---|---|---|
| `GOJIRA_AUDIT_LOG_TARGET` | `stdout` | One of: `stdout`, `file:/path/to/log`, `http(s)://endpoint`, `syslog:<facility>`. |

## Rate limiting

| Var | Default | Notes |
|---|---|---|
| `RATE_LIMIT_PER_USER` | `60` | Bucket capacity in requests per 60s window. |
| `GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT` | `5` | Tokens to burn when Atlassian returns `X-RateLimit-NearLimit: true`. |

## Networking and runtime

| Var | Default | Notes |
|---|---|---|
| `MCP_PORT` | `8081` | HTTP listener port. |
| `MCP_SERVER_URL` | `http://localhost:${MCP_PORT}` | Public URL used as the OAuth issuer. Must match what the MCP client uses to reach this server. |
| `REDIS_URL` | `redis://localhost:6379` | ioredis connection string. Use `redis://:password@host:6379` to pass auth. |
| `NODE_ENV` | `development` | One of `development`, `test`, `production`. Production turns off pino-pretty. |
| `LOG_LEVEL` | `info` | pino level: `fatal/error/warn/info/debug/trace`. |
| `TLS_CERT_PATH` | none | Path to PEM cert. **Both `TLS_CERT_PATH` and `TLS_KEY_PATH` together engage native TLS.** Set neither to run plain HTTP behind a reverse proxy (Caddy). |
| `TLS_KEY_PATH` | none | Companion. |

## Docker-compose only

| Var | Default | Notes |
|---|---|---|
| `REDIS_PASSWORD` | — | Passed to `redis-server --requirepass` in the Redis sidecar and used to build the `REDIS_URL` for the app container. |
| `CADDY_DOMAIN` | — | Hostname for the Caddy overlay (`docker-compose.caddy.yml`). Caddy will obtain a Let's Encrypt cert for this. |
| `GOJIRA_ENV_FILE` | `.env` | Which env file `docker-compose.yml` feeds to the app container (`env_file:`). Each deploy profile sets it to itself (e.g. `GOJIRA_ENV_FILE=.env.prod` in `deploy/prod.env.example`) so several instances can run from one checkout. Not read by `config.ts`. |

## Constraint validation

`config.ts` rejects at startup if:

- `TOKEN_ENCRYPTION_KEY` doesn't decode to exactly 32 bytes.
- `TLS_CERT_PATH` and `TLS_KEY_PATH` are not both set or both unset.
- `GOJIRA_ENABLE_ORG_ADMIN=true` but `GOJIRA_ORG_ADMIN_TOKEN` or
  `GOJIRA_ORG_ID` are missing.
- `GOJIRA_ENABLE_ORG_ADMIN=true` but `GOJIRA_ORG_ADMIN_ACCOUNT_IDS` is
  empty — the org-admin caller allowlist may not be blank.
- `ATLASSIAN_OAUTH_SCOPES` is empty or missing `offline_access`.
- `GOJIRA_ENABLED_GROUPS` is unset, empty, or contains an unknown group
  name.
- `NODE_ENV=production` but `MCP_SERVER_URL` is unset — otherwise the
  OAuth issuer/callback URLs silently fall back to `http://localhost`
  and the consent flow breaks.

Empty-string values are treated as unset (so copying `.env.example` and
leaving optional keys as `KEY=` falls through to the default rather than
failing a format check).

The error message lists every offending var with the zod issue:

```
Configuration error:
  - ALLOWED_ORIGINS: Required
  - TOKEN_ENCRYPTION_KEY: TOKEN_ENCRYPTION_KEY must base64-decode to exactly 32 bytes
  - ATLASSIAN_OAUTH_SCOPES: ATLASSIAN_OAUTH_SCOPES must be non-empty and include 'offline_access'
```

## See also

- [Deploy procedure](deploy-procedure.md)
- [Secrets management](secrets.md)
- [Permission groups](../tools/permission-groups.md) — what groups exist + recommended allowlist recipes
- `src/config.ts` — schema source of truth

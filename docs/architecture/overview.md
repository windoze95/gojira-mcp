# Architecture overview

gojira-mcp is a **stateless-per-process** MCP server that brokers per-user,
delegated calls to Atlassian Cloud admin APIs.

## High-level diagram

```
┌────────────────────────┐                        ┌───────────────────────────────┐
│ MCP client             │   StreamableHTTP        │ Atlassian Cloud               │
│ (Claude Desktop,       │   over OAuth 2.1        │                               │
│  VS Code chat, etc.)   │ ◄────────────────────►  │ - auth.atlassian.com          │
└──────────┬─────────────┘                         │ - api.atlassian.com           │
           │                                        │ - api.atlassian.com/admin/v1  │
           ▼                                        │ - api.atlassian.com/jsm/...   │
┌────────────────────────┐                        │ - <site>.atlassian.net         │
│ gojira-mcp              │  OAuth 2.0 3LO         └──────────────┬────────────────┘
│                         │  + per-user API token                │
│ - acts as AS to clients │  + org-admin API token (gated group) │
│ - acts as client to     │ ◄────────────────────────────────────┘
│   Atlassian             │
│ - tools dispatch        │
│ - operation journal     │       ┌───────────────────────────────┐
│ - rate limiter          │ ────► │ Redis                          │
│ - audit sink            │       │ (encrypted credentials,        │
└─────────────────────────┘       │  session state, rate buckets,  │
                                  │  journal entries, OAuth state) │
                                  └────────────────────────────────┘
```

## Process boundaries

`src/index.ts` is the entry point. In order:

1. `loadConfig()` parses environment with a zod schema; on bad input it
   prints structured errors and exits non-zero.
2. `createRedisClient(redisUrl)` returns an ioredis instance with retry
   strategy + reconnect-on-error filters.
3. `createApp(config, redis)` builds the Express app (see
   [auth-bridge.md](auth-bridge.md) and
   [session-lifecycle.md](session-lifecycle.md)).
4. Either an HTTP or HTTPS listener wraps the app — TLS engaged when both
   `TLS_CERT_PATH` and `TLS_KEY_PATH` are present.
5. SIGTERM/SIGINT closes the listener, calls `redis.quit()`, exits 0.

## Layered responsibilities

| Layer | Module path | Concern |
|---|---|---|
| Configuration | `src/config.ts` | zod-validated, fail-fast, singleton |
| Persistence | `src/redis/client.ts` | ioredis with retry strategy |
| Encryption | `src/auth/encryption.ts` | AES-256-GCM, 12-byte IV, 16-byte tag |
| Logging | `src/utils/logger.ts` | pino with redact paths on `*.token`/`Authorization` |
| Audit sink | `src/utils/audit.ts` | stdout / file / HTTP / syslog targets |
| Errors | `src/middleware/errorHandler.ts` | uniform tool error envelope |
| Atlassian client | `src/atlassian/client.ts` | axios wrapper with rate-limit-header callback |
| Retry | `src/atlassian/retry.ts` | exponential backoff + `Retry-After` |
| Error mapping | `src/atlassian/errors.ts` | upstream status → tool error code |
| OAuth provider | `src/auth/oauthProvider.ts` | client-side AS implementation |
| OAuth callback | `src/auth/oauthCallback.ts` | upstream Atlassian callback handler |
| Token refresher | `src/auth/tokenRefresh.ts` | distributed lock + CAD release |
| Refresh family | `src/auth/refreshFamily.ts` | RT reuse detection |
| Token stores | `src/auth/tokenStore.ts` + `apiTokenStore.ts` | encrypted credential persistence |
| Org-admin verifier | `src/auth/orgAdminVerifier.ts` | admin_org caller verification against the `GOJIRA_ORG_ADMIN_ACCOUNT_IDS` allowlist |
| Rate limiter | `src/middleware/rateLimiter.ts` | token-bucket Lua with NearLimit feedback |
| Journal | `src/operations/journal.ts` | per-user op log + ZSET index |
| Revert registry | `src/operations/revert.ts` | reverter functions keyed by tool name |
| Consent | `src/consent/dryRun.ts` + `jsonPatch.ts` | commit-positive consent + RFC 6902 diffs |
| Tool registry | `src/tools/registry.ts` + `wrapHandler.ts` | per-call context, operator-floor filter |
| Tools | `src/tools/defs/*.ts` | 155 tool definitions across 23 permission groups |
| Server | `src/server.ts` | Express composition, session map, MCP transport |
| Entry | `src/index.ts` | bootstrap + lifecycle |

## Per-request flow

A single `POST /mcp` call for `tools/call` walks this path:

```
requireBearerAuth (verifyAccessToken on mcp_token:<at>)
  │
  ▼
session lookup (Map<sessionId, McpServer>)  ──── new session? register tools filtered by bearer scopes
  │
  ▼
transport.handleRequest → routed to the wrapped handler
  │
  ▼
wrapHandler:
  1. extract accountId from authInfo.extra
  2. enforce operator-floor disabled groups (defense in depth)
  3. enforce org-admin caller verification (admin_org tools only)
  4. rate-limit check
  5. resolve credentials (OAuth token via refresher, optional API token)
  6. resolve cloudId (pinned or primary), enforce D4 site pinning
  7. build per-call AtlassianClient with header callback
  8. parse args, run tool handler
  9. on success: audit log success + journal entry (if mutation)
     on error: map AtlassianApiError → ToolError, audit log failure
 10. return CallToolResult { content, isError? }
```

See [session-lifecycle.md](session-lifecycle.md) for the session-level
detail, [auth-bridge.md](auth-bridge.md) for the auth flow, and
[error-model.md](error-model.md) for the envelope.

## Stateless-per-process

The server is **horizontally scalable**: every behaviour that needs to be
shared across instances (tokens, sessions, rate buckets, journal entries)
lives in Redis. Session-resumption state is the only thing kept in-process
(in `Map<sessionId, SessionEntry>`); a restart wipes sessions, clients
re-`initialize`, and continue without re-OAuth because the MCP bearer
remains valid in Redis.

The session map is acceptable to lose because:
- MCP `initialize` is idempotent and fast (<100ms);
- bearers in Redis survive process restart (1-hour AT, 30-day RT);
- there's no in-flight work to drain — tool calls are short-lived.

## Concurrency

Per-process there are two contention points:

1. **Per-user token refresh.** Multiple concurrent tool calls for the same
   user could each see a stale access token. The `TokenRefresher` uses a
   Redis `SET token_refresh_lock:<accountId> <uuid> EX 10 NX` and releases
   via Lua compare-and-delete. See
   [refresh-token-rotation.md](refresh-token-rotation.md) — that doc is about
   *MCP-issued* RT rotation; the upstream Atlassian refresh story is here in
   [auth-bridge.md](auth-bridge.md).

2. **Per-user rate bucket.** A Redis Lua script does the read/refill/decrement
   atomically; concurrent requests for the same user can never double-spend.
   See [rate-limiting.md](rate-limiting.md).

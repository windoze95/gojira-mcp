# Health checks

Three layers cover the health story:

1. **`GET /health`** — HTTP endpoint, unauthenticated.
2. **Dockerfile `HEALTHCHECK`** — container-level liveness.
3. **`gojira.health` tool** — MCP-side, accessible to clients that
   already hold a bearer.

## `GET /health`

Plain HTTP, no auth, never rate-limited.

```bash
curl -sS http://localhost:8081/health | jq
```

Response (200):

```json
{
  "status": "ok",
  "uptime": 12345.67,
  "redis": "ok",
  "duration_ms": 3,
  "timestamp": "2026-05-11T16:00:00.000Z"
}
```

Response (503, Redis unavailable):

```json
{
  "status": "degraded",
  "uptime": 12345.67,
  "redis": "fail",
  "duration_ms": 100,
  "timestamp": "2026-05-11T16:00:00.000Z"
}
```

Tests:

- pings Redis (`PING` → `PONG`)
- returns 200 on success, 503 on Redis failure
- responds within ~5 ms typically; load balancers can use it for
  back-end pool membership

## Dockerfile HEALTHCHECK

The published image runs:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --spider --tries=1 \
      "${HEALTHCHECK_PROTOCOL}://127.0.0.1:${MCP_PORT}/health" || exit 1
```

After three failures (90 seconds) the container is reported unhealthy.
`docker compose` won't route to unhealthy containers.

The `HEALTHCHECK_PROTOCOL` env defaults to `http` and only needs
overriding if you've engaged native TLS inside the container (in which
case set it to `https` and add `--no-check-certificate` if self-signed).

## `gojira.health` MCP tool

A bearer-protected tool that also pings Redis. Use from within an MCP
session to verify connectivity end-to-end (it exercises bearer auth +
Redis as one step):

```
call gojira.health
```

Returns the same shape as `/health` with a few additional fields:

```json
{
  "status": "ok",
  "redis": "ok",
  "oauth_issuer": "https://gojira.example.com",
  "enabled_groups": ["utility", "read_jsm_admin", "write_jsm_admin"],
  "pinned_cloud_id": "abc-123",
  "org_admin_enabled": false,
  "duration_ms": 3,
  "ts": "2026-05-11T16:00:00.000Z"
}
```

## What to monitor externally

| Signal | Cadence | Source | Alert when |
|---|---|---|---|
| `/health` HTTP 200 | 30 s | external uptime monitor | non-200 for > 90 s |
| `redis` field == `ok` | 30 s | the JSON body | `fail` for > 30 s |
| Container CPU / mem | 1 min | docker stats / Prometheus exporter | sustained > 80% |
| Atlassian 429 rate | 1 min | parse pino logs or audit sink | > N/min sustained |
| `REFRESH_TOKEN_REUSE` events | per occurrence | log scrape or `GOJIRA_REFRESH_REUSE_ALERT_WEBHOOK` | any |
| Disk usage | 5 min | host monitor | > 80% on the Redis volume |

## What not to monitor

- Don't poll `/mcp` with credentials for liveness — it's stateful per
  session and creates noise in the audit log.
- Don't `gojira.health` from an automated monitor on an interval — it
  still consumes one rate-limit token per call (utility tools are
  ungated but still counted). Use `/health` instead.

## See also

- [Incident response](../operations/incident-response.md)
- [Audit trail](../security/audit-trail.md)

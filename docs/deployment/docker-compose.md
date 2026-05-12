# Docker Compose

The recommended deployment shape: gojira-mcp + a Redis sidecar on an
isolated bridge network.

## Files

- `Dockerfile` — multi-stage build, `node:22-alpine` runtime, non-root
  `mcp:mcp`, OCI labels, `HEALTHCHECK` against `/health`.
- `docker-compose.yml` — service + Redis sidecar.
- `docker-compose.caddy.yml` — overlay adding a Caddy 2 reverse proxy for
  automatic TLS.
- `Caddyfile` — minimal TLS config bound to `${CADDY_DOMAIN}`.

## Plain HTTP (behind your own proxy)

```bash
# in the project root
cp .env.example .env
$EDITOR .env                    # set the required vars
docker compose up -d
```

This brings up:

| Service | Container | Network | Ports |
|---|---|---|---|
| `gojira-mcp` | `gojira-mcp` | `internal` | `8081:8081` |
| `redis` | `gojira-redis` | `internal` | `expose: 6379` (not published) |

`gojira-mcp` is health-gated on Redis (`depends_on:
service_healthy`). The Redis container is bounded at 256 MB, uses
`allkeys-lru` eviction, and `--appendonly yes` for durability.

## TLS via Caddy overlay

```bash
export CADDY_DOMAIN=gojira.example.com
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Adds:

| Service | Container | Ports |
|---|---|---|
| `caddy` | `gojira-caddy` | `80:80`, `443:443`, `443:443/udp` (HTTP/3) |

The overlay **unbinds** gojira-mcp's host port 8081 — only Caddy is
publicly reachable. Caddy obtains a Let's Encrypt cert for
`${CADDY_DOMAIN}` automatically (you need DNS A/AAAA records pointing at
the host first). HSTS is set with `max-age=63072000; includeSubDomains;
preload`.

## Native TLS (no reverse proxy)

If you'd rather terminate TLS in the Node process directly, set
`TLS_CERT_PATH` and `TLS_KEY_PATH` in the env file (both or neither).
Mount your cert directory at `/certs:ro`:

```yaml
# in docker-compose.yml (additions to the gojira-mcp service)
volumes:
  - /etc/letsencrypt/live/gojira.example.com:/certs:ro
environment:
  TLS_CERT_PATH: /certs/fullchain.pem
  TLS_KEY_PATH: /certs/privkey.pem
```

In this mode the Caddy overlay is unnecessary.

## Build

The Compose file references `image: gojira-mcp:latest` with `build:
context: .`, so `docker compose up -d --build` builds from source. For
CI/CD:

```bash
docker build -t registry.example.com/gojira-mcp:0.1.0 .
docker push registry.example.com/gojira-mcp:0.1.0
# then change image: line to the registry tag
```

## Image properties

| | |
|---|---|
| Base | `node:22-alpine` |
| User | `mcp:mcp` (non-root) |
| Exposes | `8081` |
| Healthcheck | `wget --spider http://127.0.0.1:8081/health` every 30 s |
| CMD | `node dist/index.js` |
| OCI labels | source, description, version |

## Memory tuning

Defaults are calibrated for ~hundreds of users × dozens of operations
per day:

- gojira-mcp Node process: not memory-bounded by the container; in
  practice ~200-400 MB resident.
- Redis: `--maxmemory 256mb`, `allkeys-lru`.

If the operation journal pressures Redis (workflow + scheme snapshots
can be 100 KB+), raise the cap to 512 MB or higher. Watch with:

```bash
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
    INFO memory | grep used_memory_human
```

## Restart policy

Both services use `restart: unless-stopped` — they survive host reboots
but stay down if you explicitly stop them.

## See also

- [Caddy TLS overlay](caddy-tls.md)
- [Deploy procedure](deploy-procedure.md)
- [Health checks](health-checks.md)

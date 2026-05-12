# Caddy TLS overlay

`docker-compose.caddy.yml` adds a Caddy 2 reverse proxy in front of
gojira-mcp to handle TLS termination, automatic Let's Encrypt
certificates, and HTTP/3.

## Why Caddy

| | |
|---|---|
| Setup cost | Single env var (`CADDY_DOMAIN`) + DNS pointing at the host. |
| Certs | Automatic ACME issuance + renewal. No manual cert rotation. |
| HTTPS Strict-Transport-Security | Included with safe defaults (max-age 63072000, includeSubDomains, preload). |
| HTTP/3 | UDP 443 published; modern clients prefer it. |
| Header forwarding | `X-Forwarded-Proto`, `X-Forwarded-Host` set on the upstream request. |

Switching to nginx or another proxy is straightforward — gojira-mcp
doesn't care what's in front of it.

## Files

`Caddyfile` (this project ships a minimal one):

```caddy
{$CADDY_DOMAIN} {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
    reverse_proxy gojira-mcp:8081 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
}
```

The `{$CADDY_DOMAIN}` is substituted from the env at start time.

## Bring up

```bash
export CADDY_DOMAIN=gojira.example.com

# verify DNS first
dig +short A gojira.example.com
dig +short AAAA gojira.example.com    # if you support IPv6

docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

The first request triggers Caddy's ACME flow. Within a few seconds the
cert lands and `https://gojira.example.com/health` works.

## What the overlay changes

- Resets `ports:` on gojira-mcp (`!reset []`), exposes only `8081`
  internally → not publicly reachable.
- Adds the `caddy` service binding `80:80`, `443:443`, `443:443/udp`.
- Sets `MCP_SERVER_URL=https://${CADDY_DOMAIN}` so the OAuth issuer URL
  matches the public hostname.

`MCP_SERVER_URL` matters because:

- It's the issuer in `/.well-known/oauth-authorization-server`.
- The default Atlassian callback URI is derived from it
  (`${MCP_SERVER_URL}/oauth/atlassian-callback`).

If the public URL changes (new hostname), re-register the OAuth callback
URI in the Atlassian developer console.

## Cert renewal

Caddy auto-renews 30 days before expiry. Certs and account data live in
the `caddy-data` named volume. To inspect or back up:

```bash
docker run --rm -v gojira-mcp_caddy-data:/data \
    -v "$(pwd)":/backup alpine \
    tar czf /backup/caddy-data.tgz -C /data .
```

## Connectivity check

```bash
curl -fsS "https://${CADDY_DOMAIN}/health" | jq
# expect { status: "ok", ... }
```

## Disabling HTTP/3

Some networks block UDP/443. Remove the `"443:443/udp"` line from
`docker-compose.caddy.yml` and clients will fall back to HTTPS/1.1 or 2.

## Custom Caddyfile

The included Caddyfile is intentionally minimal. To customise:

```caddy
{$CADDY_DOMAIN} {
    rate_limit { ... }            # optional, see caddy-ratelimit plugin
    log { format json output stdout }
    reverse_proxy gojira-mcp:8081 {
        # ...
    }
}
```

Restart with `docker compose restart caddy`.

## See also

- [Docker Compose](docker-compose.md)
- [Health checks](health-checks.md)
- [Deploy procedure](deploy-procedure.md)

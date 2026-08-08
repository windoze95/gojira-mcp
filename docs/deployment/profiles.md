# Split-surface profiles

Run one `gojira-mcp` image as several **simultaneous** containers, each
serving a different `GOJIRA_ENABLED_GROUPS` slice on its own port. The point
is workflow batching: instead of toggling individual tools in an MCP client,
you connect the instance whose surface matches the work and disconnect the
rest. A smaller connected surface also helps the model pick the right tool
(see [`docs/tools/overview.md`](../tools/overview.md#practical-surface-size)).

This is a different axis than the prod/sandbox split in `deploy/*.env.example`
(README Pattern 6): all profiles point at **one tenant** and differ only in
tool surface.

## The fleet

| Profile | Port | Tools | Groups beyond `utility` |
|---|---|---|---|
| `gojira-readonly` | 8081 | 26 | all 10 `read_*` groups |
| `gojira-service` | 8082 | 26 | `read/write_jsm_admin`, `read/write_assets`, `read/write_automation` |
| `gojira-platform` | 8083 | 21 | `read/write_customfields`, `read/write_projects`, `read/write_schemes`, `read/write_workflows` (`delete_projects` commented opt-in → 22) |
| `gojira-workspace` | 8084 | 19 | `read/write_agile`, `read/write_filters_dashboards`, `read/write_confluence_admin` |
| `gojira-org` | 8085 | 12 | `admin_org` (+ `GOJIRA_ENABLE_ORG_ADMIN=true`); opt-in via `--profile org` |

Every profile includes `utility` (6 tools: health, whoami, bindApiToken,
listEnabledTools, readJournal, revertOperation) — nothing auto-injects it, so it
appears in every profile's group list explicitly. The write surface is
partitioned: no write group appears in two profiles. `readonly` deliberately
overlaps the read groups so it can stay connected as the ambient browse/audit
surface while write profiles come and go.

`tests/deploy/profiles.test.ts` machine-verifies all of the above (group
names, per-profile tool counts, utility presence, write-partition, org
isolation) — a catalog change that shifts a count fails CI until the docs
and env comments are updated with it.

## Topology

One compose project (`docker-compose.profiles.yml`, standalone — don't mix
with `docker-compose.yml`): N app services from one image + **one shared
Redis**. Instances are reached over a private network as
`<scheme>://<GOJIRA_HOST>:<port>` — no reverse proxy; every container
publishes its own host port. `MCP_PORT`/`MCP_SERVER_URL`/`REDIS_URL` are
pinned in the compose `environment:` blocks (which override `env_file`) so
profile files cannot misconfigure the structural values.

**Reachability — the MCP SDK refuses `http://` issuers except for
localhost/127.0.0.1** (a non-localhost http fleet crash-loops with
`Issuer URL must be HTTPS`). `shared.env.example` walks the three variants:

- **A (default): `GOJIRA_HOST=localhost`** — clients on the same machine, or
  remote clients through an SSH tunnel / port-forward.
- **B: LAN hostname over plain http** — set
  `MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true` (the SDK's explicit
  opt-out). Bearer tokens travel unencrypted on that network; acceptable
  only on a genuinely private single-operator network.
- **C: LAN hostname over https** — `GOJIRA_URL_SCHEME=https` +
  `TLS_CERT_PATH`/`TLS_KEY_PATH` pointing into `deploy/profiles/certs/`
  (mounted read-only at `/certs`), with your CA trusted on client machines.
  Note the container healthcheck's `wget` cannot verify a private CA — rely
  on `docker compose ps` and client-side `/health` probes.

`npm run preflight:profiles` enforces the rule: variant B without the
opt-out flag is a hard ✗ before you ever boot a crash-looping fleet.

Configuration is layered:

- `deploy/profiles/shared.env` — fleet invariants, **identical for every
  instance**: Atlassian OAuth app credentials + scope superset, shared
  callback URI, pinned cloudId, `TOKEN_ENCRYPTION_KEY`, Redis password,
  posture knobs.
- `deploy/profiles/<name>.env` — what actually differs: `GOJIRA_INSTANCE_NAME`
  and `GOJIRA_ENABLED_GROUPS` (plus the org vars on the org profile).

Compose loads `shared.env` first, then the profile file, for every service.

### Setup

```bash
cp deploy/profiles/shared.env.example deploy/profiles/shared.env   # fill in
cp deploy/profiles/readonly.env.example  deploy/profiles/readonly.env
cp deploy/profiles/service.env.example   deploy/profiles/service.env
cp deploy/profiles/platform.env.example  deploy/profiles/platform.env
cp deploy/profiles/workspace.env.example deploy/profiles/workspace.env
cp deploy/profiles/org.env.example       deploy/profiles/org.env      # optional

npm run preflight:profiles     # per-profile preflight + fleet invariant checks

docker compose -p gojira -f docker-compose.profiles.yml \
  --env-file deploy/profiles/shared.env up -d --build
# include the org instance only when needed:
docker compose -p gojira -f docker-compose.profiles.yml \
  --env-file deploy/profiles/shared.env --profile org up -d
```

`--env-file deploy/profiles/shared.env` matters on every invocation: it
feeds compose *interpolation* (`GOJIRA_HOST`, `REDIS_PASSWORD`), which is a
separate mechanism from the per-service `env_file:` container env.

### One Atlassian app, one callback, shared Redis

Each instance is its own MCP OAuth authorization server (issuer =
`MCP_SERVER_URL`), so your client authorizes each connected instance
separately — expect one browser consent per instance (the upstream leg
always sends `prompt=consent`), repeated when a 30-day refresh token
expires.

Upstream, the whole fleet shares **one** Atlassian OAuth app. An Atlassian
3LO app registers a single callback URL, so `shared.env` pins
`ATLASSIAN_CALLBACK_URI` to the **readonly instance's** URL
(`http://<host>:8081/oauth/atlassian-callback`) — register exactly that URL
on the app. Atlassian always redirects there, and whichever instance
started the flow completes it, because the pending-auth state
(`pending_auth:*`, `atlassian_state:*`, `auth_code:*`) lives in the shared
Redis and is deliberately **not** instance-scoped.

Consequences:

- **The readonly instance must be running** whenever any instance runs a
  consent; otherwise the callback dead-ends ("State expired or unknown").
- If the Atlassian dev console refuses a plain-http callback for your
  host, set `TLS_CERT_PATH`/`TLS_KEY_PATH` (per instance, e.g. a private
  CA) and switch the URLs to https.
- One upstream credential (`token:<accountId>`) serves the fleet — which is
  why scopes are a fleet-wide superset, `TOKEN_ENCRYPTION_KEY` must be
  identical everywhere (a mismatched key fails decryption and silently
  purges the shared credential), and `gojira.bindApiToken` needs to run
  only once for all JSM/forms/automation/Confluence tools.

### What is shared vs. isolated

| Concern | Behavior in the fleet |
|---|---|
| MCP bearer/refresh tokens | **Isolated.** Tokens are issuer-stamped at mint; an instance rejects a sibling's tokens (`verifyAccessToken` / `exchangeRefreshToken`). Pre-upgrade tokens without the stamp are grandfathered with a warning. |
| Tool surface | **Isolated.** Registration filter + dispatch-time re-check per instance, as always. |
| Reverts | **Gated.** `gojira.revertOperation` (and its dry run) requires the *original* tool's group on the calling instance; the refusal names the owning instance (journal entries carry `instance`). |
| Upstream Atlassian credential + API-token binding | **Shared** — bind once, consent per instance against one app. |
| Operation journal | **Shared** — `gojira.readJournal` on any instance shows the fleet's history; entries are stamped with the writing instance. Revert still requires the owning surface. |
| Rate limit | **Pooled.** `RATE_LIMIT_PER_USER` is per-account in the shared Redis: 60 means 60/min for the whole fleet. Atlassian's real limits are per-user, so pooling is honest; raise it if profiles starve each other. |
| Usage metrics | **Merged.** `/metrics/usage` on any instance reports the union. |
| Audit stream | Per-instance target; every record carries `instance`. The org profile keeps a separate `GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET`. |
| MCP sessions | Per-instance, in-memory. Restarting one instance 404s only its own sessions; clients re-initialize. |

### Telling instances apart

`GOJIRA_INSTANCE_NAME` (validated `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
default `gojira-mcp`) surfaces in:

- the MCP handshake (`serverInfo.name`) and OAuth protected-resource metadata,
- `GET /health` → `instance`,
- `gojira.health`, `gojira.whoami`, `gojira.listEnabledTools` (`deployment.instance`),
- audit records (`instance`), journal entries (`instance`), and pino log bindings.

`gojira.listEnabledTools` still enumerates the full catalog by default
(marking unavailable tools with the owning-sibling hint); pass
`available_only: true` for just this instance's surface.

## Client configuration

One `mcpServers` entry per profile (see README Pattern 8 for the JSON).
Batching is then connect/disconnect: keep `gojira-readonly` attached for
browsing and audit; attach `gojira-platform` for a schemes/workflows change
batch; drop it when done. The client-side entry name is yours; the server
confirms its identity via `serverInfo.name` and `gojira.health`.

## Adding or reslicing a profile

1. Create `deploy/profiles/<name>.env.example` (+ your `.env` copy) with a
   distinct `GOJIRA_INSTANCE_NAME` and the group list.
2. Add a service in `docker-compose.profiles.yml` (copy a block; bump the
   published port and the `MCP_SERVER_URL` port).
3. Update `EXPECTED_COUNTS` in `tests/deploy/profiles.test.ts` and the
   tables here + in README Pattern 8 — the test fails until counts match.
4. `npm run preflight:profiles` — catches duplicate names, missing
   `utility`, invariant drift, and >1 org-admin profile.
5. Register nothing new with Atlassian: the shared callback covers new
   instances automatically.

## See also

- [`docs/reference/redis-schema.md`](../reference/redis-schema.md) — key
  inventory incl. the issuer stamp and journal `instance` field
- [`docs/oauth/flow.md`](../oauth/flow.md) — the two-leg flow incl. the
  fleet's shared-callback variant
- [`docs/tools/permission-groups.md`](../tools/permission-groups.md) — what
  each group contains

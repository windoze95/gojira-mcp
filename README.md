# gojira-mcp

Atlassian Cloud admin MCP server. Wraps the platform-administration surface
that the official Atlassian Rovo MCP deliberately omits — project/scheme
management, custom field admin, Jira automation CRUD, Assets (Insight) CMDB,
JSM request type / SLA / queue config, Confluence space lifecycle, and the
org-admin APIs at `admin.atlassian.com`.

Designed to run alongside the official Atlassian MCP in a single client
session, not as a replacement.

---

## Status

| | |
|---|---|
| **Stack** | Node 22, TypeScript strict, Express 5, `@modelcontextprotocol/sdk` ^1.27, ioredis, axios, zod, pino |
| **Transport** | StreamableHTTP, per-session in-memory |
| **Auth** | OAuth 2.1 to MCP clients; OAuth 2.0 3LO to Atlassian; per-user API token side-channel; org-admin API token (separate gate) |
| **Persistence** | Redis (encrypted credentials, session state, rate buckets, operation journal, OAuth artifacts) |
| **Tool count** | 155 across 23 permission groups (post-remediation — tools targeting non-existent Atlassian endpoints were removed; see below) |
| **Interactive UI** | MCP Apps (SEP-1865): every destructive tool renders its dry-run as a diff/confirm card; journal timeline, Assets AQL table, and automation-rule tree viewers. Renders in claude.ai/Desktop/mobile and ChatGPT dev-mode hosts; text-only clients unaffected. `GOJIRA_UI_ENABLED` — see [MCP Apps UI](docs/architecture/mcp-apps-ui.md) |
| **Tests** | 93 unit tests across 19 files covering auth, consent, journal, rate-limiting, retry, org-admin gate, revert coverage, site-pinning, and MCP Apps metadata/resources — plus a live-tenant e2e rig (`npm run e2e`, see [battle-testing](docs/development/battle-testing.md)) |

---

## Interactive UI

Tools that benefit from it ship an [MCP Apps](docs/architecture/mcp-apps-ui.md)
template, so UI-capable hosts (claude.ai web/Desktop/mobile, ChatGPT
developer-mode connectors) render the result instead of a JSON blob. Text-only
clients — including Claude Code — are unaffected.

**Every destructive tool renders its dry-run as a diff card.** Nothing changes
until you press Commit, which re-invokes the same tool with `commit: true`
through the normal pipeline (auth, rate limit, site pinning, journal, audit).

![Confirm card for a permission-scheme update, showing the RFC 6902 patch and a Commit button](docs/assets/ui/confirm-permission-scheme.png)

Delete tools state the blast radius in the card. `projects.deleteJiraProject`
is bimodal — trash (60-day undo) versus permanent — and says which one you are
about to do:

![Confirm card for a permanent project delete, flagged NO UNDO](docs/assets/ui/confirm-delete-permanent.png)

**Operation journal** — timeline of what you changed, with per-entry drill-in
(the diff is computed client-side from the before/after snapshots) and a
dry-run-first revert:

![Journal timeline listing recent operations with outcome, tool, target and revertibility](docs/assets/ui/journal-timeline.png)

![Expanded journal entry showing target, request, and the patch applied by the operation](docs/assets/ui/journal-detail.png)

![Revert preview showing the reverse patch and a Confirm revert button](docs/assets/ui/journal-revert-preview.png)

**Assets (CMDB) AQL search** — object types carry different attribute sets, so
columns are discovered from the response, with a column picker and paging:

![Assets AQL results table with dynamic attribute columns and pagination](docs/assets/ui/aql-table.png)

**Automation rules** — the trigger → conditions → actions tree, which is the
part that reads worst as raw JSON:

![Automation rule inspector showing a trigger, condition block, and nested actions](docs/assets/ui/automation-rule-tree.png)

Views follow the host's theme and style tokens:

![The journal timeline rendered in dark theme](docs/assets/ui/journal-timeline-dark.png)

> Screenshots are produced by the local render harness (`npm run ui:harness`),
> which drives the real MCP Apps postMessage bridge against fixture data — no
> Atlassian tenant involved.

---

## Quickstart

> **Deploying for real?** Follow the end-to-end
> **[Turn-key setup guide](docs/deployment/turnkey-setup.md)** — it has the
> complete, verified scope list (including the granular Confluence/CMDB scopes),
> the API-token binding step, and `npm run preflight` to validate a config before
> go-live. The quickstart below is the condensed version.

### 1. Generate an encryption key

```bash
npm install
npm run generate-key
# copy the base64 string into TOKEN_ENCRYPTION_KEY in your .env
```

### 2. Configure

```bash
cp .env.example .env
$EDITOR .env
```

Required at minimum:
- `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET` from the
  Atlassian developer console
- `ATLASSIAN_OAUTH_SCOPES` — space-separated Atlassian OAuth scopes (must include `offline_access`)
- `TOKEN_ENCRYPTION_KEY` — output of `npm run generate-key`
- `ALLOWED_ORIGINS` — `*` for development, explicit origins for production
- `MCP_SERVER_URL` — public URL of this server (callback must match)

See [docs/deployment/environment-variables.md](docs/deployment/environment-variables.md)
for the full list with defaults and gotchas.

### 3. Run

**Locally (dev):**
```bash
docker run --rm -p 6379:6379 redis:7-alpine    # in one terminal
npm run dev                                     # in another
```

**Docker (production):**
```bash
docker compose up -d
# or with a Caddy TLS overlay:
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

The server listens on `MCP_PORT` (default `8081`) with:
- `GET  /health` — unauthenticated liveness + Redis ping
- `GET  /metrics/usage` — per-tool/per-user usage counters (only when `GOJIRA_METRICS_TOKEN` is set)
- `GET  /.well-known/oauth-authorization-server` — OAuth metadata
- `POST /register` — RFC 7591 client registration
- `GET  /authorize` — OAuth 2.1 authorize entry
- `POST /token` — token + refresh endpoint
- `POST /revoke` — token revocation
- `GET  /oauth/atlassian-callback` — upstream callback
- `POST|GET|DELETE /mcp` — bearer-protected MCP transport

### 4. Verify

```bash
curl -fsS "http://localhost:8081/health" | jq
```

Then point an MCP client (Claude Desktop, VS Code chat, Claude Code, Cursor)
at `https://<host>/mcp`. The client will discover the OAuth endpoints, walk
the consent flow with you against Atlassian, and start calling tools.

For first-time setup of the JSM, Confluence-admin, and automation tools,
call `gojira.bindApiToken` once to attach a per-user Atlassian API token.
(The automation tools additionally require that token's account be a
Jira administrator.) The Assets tools do *not* use the API token — they
ride OAuth and need the CMDB granular scopes in
`ATLASSIAN_OAUTH_SCOPES`.

---

## Deployment patterns

One image, many configs. Each deployment shape below is a different
`.env` file pointing at the same `gojira-mcp:latest` image. Run as
many side-by-side instances as you need — different hostnames, ports,
audit channels, and tool surfaces, all isolated from each other.

The total tool count for each pattern is shown next to the pattern
name. Lower is better for model selection accuracy — see
[`docs/tools/overview.md`](docs/tools/overview.md#practical-surface-size).

| Pattern | Tool count | Use case |
|---|---|---|
| 1 — Default safe (admin sandbox) | **137** | Single team's daily admin instance |
| 2 — Read-only audit | **80** | Compliance / forensic review |
| 3 — JSM/Assets specialist | **54** | Service-desk operators |
| 4 — Schemes/workflows admin | **63** | Jira config-changes only |
| 5 — Org-admin (separate host) | **24** | `admin.atlassian.com` only |
| 6 — Multi-tenant (prod + sandbox) | **137 each** | Two pinned instances side-by-side |
| 7 — Local development | **137** | Same as default safe + debug logs |
| 8 — Split-surface fleet | **80/65/51/35** (+24) | One tenant, several simultaneous instances — batch tools by connecting/disconnecting servers |

### Permission groups (legend)

Each value in `GOJIRA_ENABLED_GROUPS` names one of these 23 groups. The
allowlist is required at startup and validated against this list;
unknown names fail loudly. See
[`docs/tools/permission-groups.md`](docs/tools/permission-groups.md)
for the per-tool breakdown and
[`docs/tools/catalog.md`](docs/tools/catalog.md) for the full
auto-generated catalog.

| Group | Product | Tools | Auth | Surface |
|---|---|---|---|---|
| `utility` | gojira itself | 7 | mixed | Health, identity, journal, side-channel API-token binding |
| `read_projects` | Jira | 3 | oauth | List/get project admin view + details |
| `write_projects` | Jira | 2 | oauth | Create + archive (delete is its own group) |
| `delete_projects` | Jira | 1 | oauth | **Isolated** — `projects.deleteJiraProject` only |
| `read_schemes` | Jira | 13 | oauth | Permission / notification / workflow / screen / issue-type / field-config schemes — read |
| `write_schemes` | Jira | 7 | oauth | Create/update/delete schemes + project assignments |
| `read_workflows` | Jira | 6 | oauth | List/get workflows + transition components |
| `write_workflows` | Jira | 5 | oauth | Create/update/delete workflows, transitions, publish |
| `read_automation` | Jira | 5 | api_token | Automation rules, manual-rule search, templates — read |
| `write_automation` | Jira | 6 | api_token | Create (incl. from template)/update/delete/enable/disable rules |
| `read_customfields` | Jira | 3 | oauth | Custom fields and contexts — read |
| `write_customfields` | Jira | 5 | oauth | Create/update/delete fields, contexts, options |
| `read_filters_dashboards` | Jira | 4 | oauth | List/get filters and dashboards |
| `write_filters_dashboards` | Jira | 6 | oauth | Create/update/delete filters and dashboards |
| `read_agile` | Jira Software | 6 | oauth | Boards, sprints, epics — read |
| `write_agile` | Jira Software | 2 | oauth | Create/update sprints |
| `read_jsm_admin` | Jira Service Management | 17 | api_token | Service desks, queues, SLA state, forms — read |
| `write_jsm_admin` | Jira Service Management | 7 | api_token | Same surface + form templates — create/update/delete |
| `read_assets` | Assets (JSM add-on) | 10 | oauth | Assets/Insight schemas, types, objects — read |
| `write_assets` | Assets (JSM add-on) | 13 | oauth | Mutate Assets data and schema |
| `read_confluence_admin` | Confluence | 6 | api_token | Spaces, templates, blueprints, restrictions — read |
| `write_confluence_admin` | Confluence | 4 | api_token | Create/update/delete spaces, set restrictions (restrictions need a paid Confluence plan) |
| `admin_org` | Atlassian Org (`admin.atlassian.com`) | 17 | org_admin | All org-admin ops — **also gated by `GOJIRA_ENABLE_ORG_ADMIN`** |

Notes:
- `delete_projects` is split out from `write_projects` so an operator
  can grant create/archive without granting deletion.
- `admin_org` needs **both** allowlisting *and*
  `GOJIRA_ENABLE_ORG_ADMIN=true`; see
  [`docs/oauth/org-admin-token.md`](docs/oauth/org-admin-token.md).
- Auth column reflects how the tool reaches Atlassian: `oauth` =
  per-user OAuth bearer; `api_token` = per-user side-channel token via
  `gojira.bindApiToken`; `org_admin` = the single global
  `GOJIRA_ORG_ADMIN_TOKEN`; `mixed` = some tools in the group don't
  need any credential (e.g. `gojira.health`).
- The automation groups reach the Automation REST API with the bound
  API token, and additionally require the token's account to be a
  **Jira administrator** — a non-admin token gets `403` on every
  automation call. Bind a token created *after* the admin grant; a
  token minted before it keeps its stale permissions.
- The assets groups are OAuth, not API-token — but they need the thirteen
  **CMDB granular scopes** (`read:cmdb-object:jira`,
  `write:cmdb-object:jira`, `read:cmdb-schema:jira`,
  `write:cmdb-schema:jira`, `read:cmdb-type:jira`,
  `write:cmdb-type:jira`, `read:cmdb-attribute:jira`,
  `write:cmdb-attribute:jira`, `delete:cmdb-object:jira`,
  `delete:cmdb-schema:jira`, `delete:cmdb-type:jira`,
  `delete:cmdb-attribute:jira`, `import:import-configuration:cmdb`) in
  `ATLASSIAN_OAUTH_SCOPES` on top of the JSM scopes that workspace
  discovery uses. Assets also requires a **Premium** JSM plan; on lower
  plans every Assets call `403`s.

### Pattern 1 — Default safe (admin sandbox) · 137 tools

Daily admin work, no destructive project deletion, no org-admin path.
Good starting point for a single team's instance.

Active groups: `utility`, all 10 `read_*`, all 9 `write_*`, plus
`write_projects` (but **not** `delete_projects` or `admin_org`).

```bash
ATLASSIAN_OAUTH_CLIENT_ID=...
ATLASSIAN_OAUTH_CLIENT_SECRET=...
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira delete:cmdb-object:jira delete:cmdb-schema:jira delete:cmdb-type:jira delete:cmdb-attribute:jira import:import-configuration:cmdb
ATLASSIAN_PINNED_CLOUD_ID=<prod-cloud-id>
TOKEN_ENCRYPTION_KEY=<base64>
ALLOWED_ORIGINS=*
MCP_SERVER_URL=https://gojira.example.com
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets,read_automation,write_automation,read_customfields,write_customfields,read_projects,write_projects,read_schemes,write_schemes,read_workflows,write_workflows,read_confluence_admin,write_confluence_admin,read_agile,write_agile,read_filters_dashboards,write_filters_dashboards
```

### Pattern 2 — Read-only audit · 80 tools

Only `utility` + every `read_*` group enabled. Useful for compliance
reviewers, incident investigators, or any flow that must not mutate
Atlassian state.

Active groups: `utility` + all 10 `read_*` groups.

```bash
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,read_assets,read_automation,read_customfields,read_projects,read_schemes,read_workflows,read_confluence_admin,read_agile,read_filters_dashboards
```

(Same auth/secret/cloud config as Pattern 1.)

### Pattern 3 — JSM/Assets specialist · 54 tools

Service-desk operators who only need JSM and Assets.

Active groups: `utility`, `read_jsm_admin`, `write_jsm_admin`,
`read_assets`, `write_assets`.

```bash
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira delete:cmdb-object:jira delete:cmdb-schema:jira delete:cmdb-type:jira delete:cmdb-attribute:jira import:import-configuration:cmdb
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets
```

### Pattern 4 — Schemes/workflows admin · 63 tools

Configuration-change instance for Jira admins. JSM, Assets, Confluence,
agile, and filters/dashboards are absent.

Active groups: `utility`, `read_automation`, `write_automation`,
`read_customfields`, `write_customfields`, `read_projects`,
`write_projects`, `delete_projects`, `read_schemes`, `write_schemes`,
`read_workflows`, `write_workflows`.

```bash
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration
GOJIRA_ENABLED_GROUPS=utility,read_automation,write_automation,read_customfields,write_customfields,read_projects,write_projects,delete_projects,read_schemes,write_schemes,read_workflows,write_workflows
```

The automation groups don't ride the OAuth scopes above — each user
binds a Jira-admin API token via `gojira.bindApiToken` (see the
legend notes).

### Pattern 5 — Org-admin (separate instance, separate host) · 24 tools

Run on its own hostname/port. Only `admin_org` and utility tools
register. Audit goes to a separate channel.

Active groups: `utility`, `admin_org`.

```bash
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account
ATLASSIAN_PINNED_CLOUD_ID=<prod-cloud-id>
GOJIRA_ENABLE_ORG_ADMIN=true
GOJIRA_ORG_ADMIN_TOKEN=<admin.atlassian.com api token>
GOJIRA_ORG_ID=<your-org-id>
GOJIRA_ORG_ADMIN_ACCOUNT_IDS=<accountId>,<accountId>
GOJIRA_ORG_ADMIN_AUDIT_LOG_TARGET=file:/var/log/gojira/org-admin.log
GOJIRA_ENABLED_GROUPS=utility,admin_org
```

All four `GOJIRA_ORG_*` values above are **required** when
`GOJIRA_ENABLE_ORG_ADMIN=true` — `src/config.ts` refuses to start
otherwise, including on an empty `GOJIRA_ORG_ADMIN_ACCOUNT_IDS`.

Caller verification is that allowlist: `admin_org` tools only run for a
caller whose Atlassian accountId is listed in
`GOJIRA_ORG_ADMIN_ACCOUNT_IDS`; everyone else gets
`INSUFFICIENT_PERMISSIONS`. The server deliberately does **not** ask
Atlassian whether the caller is an org admin — the org user API returns
every managed account in the org, not just admins, so checking against
it would let any licensed user act with this deployment's global
org-admin token. The permitted set is operator-declared and fails
closed.

### Pattern 6 — Multi-tenant (prod + sandbox side-by-side) · 137 tools each

Two instances, same image, two compose stacks, two hostnames:

```
gojira.prod.example.com    →  ATLASSIAN_PINNED_CLOUD_ID=<prod cloudId>
gojira.sandbox.example.com →  ATLASSIAN_PINNED_CLOUD_ID=<sandbox cloudId>
```

Both use the Pattern-1 `GOJIRA_ENABLED_GROUPS`. A user with grants on
both cloudIds can connect both as separate connectors in their MCP
client; site pinning ensures each instance only ever talks to its own
tenant.

### Pattern 7 — Local development · 137 tools

```bash
ATLASSIAN_OAUTH_CLIENT_ID=...
ATLASSIAN_OAUTH_CLIENT_SECRET=...
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira delete:cmdb-object:jira delete:cmdb-schema:jira delete:cmdb-type:jira delete:cmdb-attribute:jira import:import-configuration:cmdb
TOKEN_ENCRYPTION_KEY=<base64>
ALLOWED_ORIGINS=*
MCP_SERVER_URL=http://localhost:8081
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets,read_automation,write_automation,read_customfields,write_customfields,read_projects,write_projects,read_schemes,write_schemes,read_workflows,write_workflows,read_confluence_admin,write_confluence_admin,read_agile,write_agile,read_filters_dashboards,write_filters_dashboards
LOG_LEVEL=debug
NODE_ENV=development
# no PINNED_CLOUD_ID — use the user's primary cloudId
```

### Pattern 8 — Split-surface fleet · 80/65/51/35 (+24) tools

One tenant, one image, several *simultaneous* containers — each serving a
different slice of the catalog on its own port. Instead of toggling 155
tools in your MCP client, connect and disconnect whole servers to batch
tool availability to the work at hand. Full guide:
[`docs/deployment/profiles.md`](docs/deployment/profiles.md).

| Profile | Port | Tools | Surface |
|---|---|---|---|
| `gojira-readonly` | 8081 | 80 | `utility` + every `read_*` group — stay connected to this one; also the fleet's OAuth callback anchor |
| `gojira-service` | 8082 | 65 | JSM admin + forms + Assets/CMDB + automation, read+write |
| `gojira-platform` | 8083 | 51 | Projects, schemes, workflows, custom fields, read+write (`delete_projects` opt-in) |
| `gojira-workspace` | 8084 | 35 | Agile boards, filters/dashboards, Confluence spaces, read+write |
| `gojira-org` | 8085 | 24 | `admin_org`, isolated; only starts with `--profile org` |

The fleet shares one Redis and one Atlassian OAuth app: you consent once
per instance (against the same app), bind the API token once for the whole
fleet, and see one merged operation journal. Two safeguards make the
"disconnect the write server = writes are off" model real: bearer tokens
are issuer-stamped (an instance rejects a sibling's tokens), and
`gojira.revertOperation` refuses to revert an operation whose original
tool's group is not enabled on the calling instance.

```bash
cp deploy/profiles/shared.env.example deploy/profiles/shared.env    # fleet invariants
cp deploy/profiles/readonly.env.example deploy/profiles/readonly.env  # + each profile you run
npm run preflight:profiles
docker compose -p gojira -f docker-compose.profiles.yml \
  --env-file deploy/profiles/shared.env up -d --build
```

Reachability: the MCP SDK only accepts `http://` server URLs for
localhost — for a LAN hostname either opt out explicitly
(`MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true`) or run https with
in-process TLS. `shared.env.example` documents all three variants and
`npm run preflight:profiles` enforces the choice before boot.

Client config — one entry per profile, connect/disconnect as needed:

```json
{
  "mcpServers": {
    "gojira-readonly":  { "type": "http", "url": "http://gojira.internal.example.com:8081/mcp" },
    "gojira-service":   { "type": "http", "url": "http://gojira.internal.example.com:8082/mcp" },
    "gojira-platform":  { "type": "http", "url": "http://gojira.internal.example.com:8083/mcp" },
    "gojira-workspace": { "type": "http", "url": "http://gojira.internal.example.com:8084/mcp" }
  }
}
```

---

## Documentation map

### Architecture
- [Overview](docs/architecture/overview.md)
- [Auth bridge](docs/architecture/auth-bridge.md)
- [Session lifecycle](docs/architecture/session-lifecycle.md)
- [Rate limiting](docs/architecture/rate-limiting.md)
- [Operation journal](docs/architecture/operation-journal.md)
- [Commit-positive consent](docs/architecture/commit-positive-consent.md)
- [Site pinning](docs/architecture/site-pinning.md)
- [Refresh-token rotation](docs/architecture/refresh-token-rotation.md)
- [Error model](docs/architecture/error-model.md)

### OAuth
- [Flow](docs/oauth/flow.md)
- [OAuth scope handling](docs/oauth/scope-grammar.md)
- [API-token side-channel](docs/oauth/api-token-side-channel.md)
- [Org-admin token](docs/oauth/org-admin-token.md)

### Tools
- [Overview](docs/tools/overview.md)
- [Permission groups](docs/tools/permission-groups.md)
- [Utility tools](docs/tools/utility.md)
- [Daily admin tools](docs/tools/daily-admin.md)
- [Schemes, workflows, Confluence admin](docs/tools/schemes-and-workflows.md)
- [Agile and views](docs/tools/agile-and-views.md)
- [Org admin (gated)](docs/tools/org-admin.md)
- [Full catalog (auto-generated)](docs/tools/catalog.md)

### Deployment
- [Environment variables](docs/deployment/environment-variables.md)
- [Docker Compose](docs/deployment/docker-compose.md)
- [Split-surface profiles](docs/deployment/profiles.md)
- [Caddy TLS overlay](docs/deployment/caddy-tls.md)
- [Secrets management](docs/deployment/secrets.md)
- [Deploy procedure](docs/deployment/deploy-procedure.md)
- [Health checks](docs/deployment/health-checks.md)

### Security
- [Threat model](docs/security/threat-model.md)
- [Error codes](docs/security/error-codes.md)
- [Audit trail](docs/security/audit-trail.md)
- [Refresh-token reuse detection](docs/security/refresh-reuse.md)

### Operations
- [Journal and revert](docs/operations/journal-and-revert.md)
- [Incident response](docs/operations/incident-response.md)
- [Backup and recovery](docs/operations/backup.md)

### Development
- [Repo layout](docs/development/repo-layout.md)
- [Testing](docs/development/testing.md)
- [Battle-testing (live e2e)](docs/development/battle-testing.md)
- [Adding a tool](docs/development/adding-a-tool.md)

### Reference
- [Redis schema](docs/reference/redis-schema.md)
- [HTTP routes](docs/reference/http-routes.md)

---

## Design properties

The features below are the things this server does that a naïve admin MCP
typically gets wrong:

1. **Per-user delegation.** Every upstream Atlassian call is attributable to a real human; no service-account proxying.
2. **End-to-end identity binding.** Tools cannot accept a caller/requester field from the client; identity is derived from the bearer.
3. **Encrypted-at-rest credentials.** AES-256-GCM, unique IV per write, tampered blobs auto-purge.
4. **Distributed refresh lock with compare-and-delete.** No thundering herd at token expiry; no accidental unlock by a stale holder.
5. **Atomic one-time-use** for state, codes, and refresh artifacts (`GETDEL`).
6. **OAuth error pass-through** to MCP client's `redirect_uri` — never a hung client on JSON 500.
7. **Allowlist-based query construction** — no string concatenation of user input into upstream queries.
8. **Fail-open rate limiting, fail-closed auth.** Availability for non-security failures; never bypass identity.
9. **Health endpoint outside the auth boundary** — observability without privilege.
10. **Token redaction in logs** as defense in depth.
11. **Rotating MCP refresh tokens with reuse detection.** Family-tracked; presenting a previously-rotated RT while siblings are alive triggers full-family revocation + a `REFRESH_TOKEN_REUSE` audit event.
12. **Operation journal with prior-state snapshots and revert.** Every destructive admin write captures `before` state; revertible operations can be undone by replaying the inverse mutation as a new journaled op.
13. **Operator-controlled tool surface, least-privilege by default.** Permission groups + the `admin_org` gate are the runtime knobs. `GOJIRA_ENABLED_GROUPS` is an explicit allowlist (no implicit default) that filters the registered surface at session creation and again at dispatch. No client-side scope grammar to mismanage.
14. **Site pinning at deploy time.** `ATLASSIAN_PINNED_CLOUD_ID` refuses any tool invocation whose target cloudId differs from the pinned value.
15. **Commit-positive consent on destructive writes.** Tools without `commit: true` return a JSON Patch dry-run; forgotten flag fails closed.
16. **Rate-limit-header-aware throttling.** `X-RateLimit-NearLimit` triggers proactive extra-token deduction; `X-RateLimit-Reset` soft-caps the bucket until the future window.
17. **Three-tier auth strategy** with explicit isolation of the org-admin path.

---

## License

Internal / unlicensed. See package.json.

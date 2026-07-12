# Turn-key setup

The single, authoritative guide to standing up gojira-mcp on **any** Atlassian
Cloud org — from a fresh clone to answering tool calls. Every step here has been
exercised end-to-end against a live tenant.

> New here? This supersedes the older [deploy-procedure.md](deploy-procedure.md)
> for the scope list and the API-token step. Read this one first.

---

## 0. What you'll end up with

- A running server that bridges MCP clients (Claude Desktop/Code, Cursor, VS Code)
  to your Atlassian org via per-user OAuth.
- A tool surface scoped to exactly the permission groups you enable.
- TLS termination (via the Caddy overlay) and a Redis that persists encrypted
  credentials + the operation journal.

## 1. Prerequisites

- **You are an org admin** on the target Atlassian Cloud org (needed to grant the
  admin scopes and, for org-admin tools, an admin API key).
- A host that runs Docker Compose (Linux, ≥2 GB RAM), or Node 22+ for local dev.
- Outbound HTTPS to `*.atlassian.com`, `auth.atlassian.com`, `api.atlassian.com`.
- A DNS record for your chosen hostname if you use TLS (recommended).

## 2. Register the OAuth 2.0 (3LO) app

1. Go to <https://developer.atlassian.com/console/myapps/> → **Create** →
   **OAuth 2.0 integration**.
2. Name it (e.g. `gojira-mcp — prod`). Accept the developer terms.
3. **Authorization → Add → OAuth 2.0 (3LO)**: set the **Callback URL** to
   `https://<your-host>/oauth/atlassian-callback` (for local dev,
   `http://localhost:8081/oauth/atlassian-callback`). Add both if you test locally.
4. **Settings**: copy the **Client ID** and **Client secret**.

## 3. Add API scopes — the part most guides get wrong

gojira spans several Atlassian APIs, and some require **granular** scopes that a
classic-scope token cannot substitute for. Add the scopes for the groups you plan
to enable. In the developer console, **Permissions → each API → Edit Scopes**;
some scopes live under the **Granular scopes** tab.

`offline_access`, `read:me`, `read:account` are always required.

| Permission group(s) | API | Scopes to add |
|---|---|---|
| `read_projects` `write_projects` `delete_projects` `read_schemes` `write_schemes` `read_customfields` `write_customfields` `read_filters_dashboards` `write_filters_dashboards` `read_agile` `write_agile` | Jira (classic) | `read:jira-work` `write:jira-work` `manage:jira-project` `manage:jira-configuration` |
| `read_workflows` `write_workflows` | Jira (classic) | `manage:jira-configuration` (workflow reads/writes + scheme publish) |
| `read_jsm_admin` `write_jsm_admin` | — (uses the bound per-user API token, not OAuth) | **No OAuth scopes needed.** Every tool in these groups (`jsm.*` and `forms.*`) authenticates with the bound API token via the site host (Basic) — no OAuth token is ever presented, so the classic `*:servicedesk-request` scopes buy nothing here. Bind the token per §9. |
| `read_confluence_admin` `write_confluence_admin` | — (uses the bound per-user API token, not OAuth) | **No OAuth scopes needed.** Confluence admin tools authenticate with the bound API token via the site host (Basic). Verified live: the OAuth host 401s v2 reads without granular scopes and returns **410 Gone** for the v1 space API these tools need, so the token path is the only complete one. Note: `setContentRestrictions` requires a paid Confluence plan (403 on Free). |
| `read_assets` `write_assets` | Jira → **Granular scopes** (CMDB) **+** Jira Service Management (classic) | `read:cmdb-object:jira` `write:cmdb-object:jira` `read:cmdb-schema:jira` `write:cmdb-schema:jira` `read:cmdb-type:jira` `write:cmdb-type:jira` `read:cmdb-attribute:jira` `write:cmdb-attribute:jira` **plus** `read:servicedesk-request` — Assets calls are OAuth-authed, and before any of them can run gojira resolves the workspaceId with an OAuth-authed `GET /rest/servicedeskapi/assets/workspace` (`src/atlassian/assetsWorkspace.ts`). Without the JSM read scope that discovery call fails and **every** `assets.*` tool errors, CMDB scopes or not. |
| `read_automation` `write_automation` | — (uses the bound per-user API token, not OAuth) | **No OAuth scope needed or available.** Automation tools authenticate with the API token bound via `gojira.bindApiToken` (Basic auth). Requirement: the token's account must be a **Jira administrator**, or every call 403s. |
| `admin_org` | — (uses a separate org-admin API key, not OAuth) | See §8. |

`ATLASSIAN_OAUTH_SCOPES` (below) requests a subset of what the app declares — so
you can declare a superset here and narrow per deployment.

## 4. Generate the encryption key

```bash
npm install
npm run generate-key   # prints a base64, 32-byte key
```

## 5. Configure `.env`

`cp .env.example .env` and fill in. A daily-admin example (JSM + Jira + Confluence,
no org admin, no automation):

```bash
ATLASSIAN_OAUTH_CLIENT_ID=...
ATLASSIAN_OAUTH_CLIENT_SECRET=...
# Include EVERY scope the enabled groups need (must match §3, incl. granular).
# `read:servicedesk-request` is here for the Assets workspace-discovery call, not
# for the JSM/forms tools — those ride the bound API token and need no scope.
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira
ATLASSIAN_PINNED_CLOUD_ID=<this instance's cloudId>   # strongly recommended
TOKEN_ENCRYPTION_KEY=<from step 4>
MCP_SERVER_URL=https://<your-host>
ALLOWED_ORIGINS=https://<your-mcp-client-origin>       # avoid '*' in prod
NODE_ENV=production
REDIS_PASSWORD=<a strong password>
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets,read_customfields,write_customfields,read_projects,write_projects,read_schemes,write_schemes,read_workflows,write_workflows,read_confluence_admin,write_confluence_admin,read_agile,write_agile,read_filters_dashboards,write_filters_dashboards
```

> Find `<cloudId>` at `https://<your-site>.atlassian.net/_edge/tenant_info`.

## 6. Preflight

```bash
./scripts/preflight.sh                       # validate ./.env
./scripts/preflight.sh --health https://<your-host>   # also ping /health after start
```

It fails on missing required vars / a bad key, and **warns** when an enabled group
is missing its scopes, notes the automation-token requirement, or on insecure prod posture
(`ALLOWED_ORIGINS=*`, `NODE_ENV != production`, plain-http `MCP_SERVER_URL`).
Get it to "passed" (warnings reviewed) before go-live.

## 7. Run

```bash
# With TLS (recommended): Caddy terminates HTTPS, app stays internal.
CADDY_DOMAIN=<your-host> docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d

# Or plain (loopback only — front it yourself):
docker compose up -d

# Local dev:
docker run --rm -p 6379:6379 redis:7-alpine    # one terminal
npm run dev                                     # another
```

Verify: `curl -fsS https://<your-host>/health | jq` → `{"status":"ok","redis":"ok"}`.

## 8. Connect a client and consent

Point your MCP client at `https://<your-host>/mcp`. It auto-discovers the OAuth
endpoints, walks you through Atlassian consent (you pick the site), and starts
listing tools. Each upstream call is attributable to the consenting user.

## 9. Bind the API token (per user, one-time)

The `read_jsm_admin` / `write_jsm_admin`, `read_automation` /
`write_automation`, **and** `read_confluence_admin` / `write_confluence_admin`
tools authenticate with a per-user Atlassian **API token** side-channel (not
OAuth). Each user runs this once:

1. Create a token at <https://id.atlassian.com/manage-profile/security/api-tokens>
   ("Create API token"). Copy it. *(This page requires an emailed one-time
   passcode to your account — a normal Atlassian identity step.)*
2. In your MCP client, call **`gojira.bindApiToken`** with your Atlassian email,
   the token, and your bare site host (`site_url=<your>.atlassian.net`). gojira
   validates the credential with a `GET /rest/api/3/myself` against that site,
   refuses it unless its accountId matches your OAuth-authenticated identity, and
   stores it encrypted at rest. That is all it does — it performs no Assets
   workspace discovery (that happens lazily, over OAuth, on the first `assets.*`
   call).

For the **automation** groups, the token's account must be a **Jira
administrator** (see §3) — otherwise every automation call 403s. Grant admin
*before* creating the token: a token minted before the grant keeps the old
permissions.

(Assets tools use OAuth — the CMDB granular scopes plus `read:servicedesk-request`
from §3 — not the API token.)

## 10. Multiple instances / prod + non-prod

Same image, one env file per instance, different `ATLASSIAN_PINNED_CLOUD_ID`
and hostname. Site-pinning refuses any tool call whose target cloudId ≠ the
pinned value, so a prod instance can never touch a sandbox tenant and
vice-versa. Ready-made profiles live in `deploy/`:

```bash
cp deploy/prod.env.example .env.prod && cp deploy/nonprod.env.example .env.nonprod
docker compose -p gojira-prod    --env-file .env.prod    -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose -p gojira-nonprod --env-file .env.nonprod -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Day-2 operations (upgrade, backup, secret rotation, incident response):
[runbook.md](runbook.md).

## 11. What this server deliberately does NOT do

These capabilities have **no public Atlassian Cloud REST API**, so there are no
tools for them (earlier versions shipped tools that 404'd — those were removed):

- JSM **SLA configuration**, **queue** create/update/delete, **portal**
  announcements/branding, knowledge-base **linking**. (SLA *state* per request
  and KB article *search* are available.)
- Org-level **Marketplace app** management, **domain verification**, **Rovo MCP**
  settings.

(Jira **Forms** *is* available — the `forms.*` tools ride the same bound API
token as JSM admin, no extra scope. Jira **automation** CRUD *is* available —
not via OAuth, but through the bound
API token; see §3 and `docs/architecture/jsm-capability-map.md`.)

## 12. Org-admin tools (optional, isolated)

Run these on a **separate** instance/host. They use a single global org-admin API
key, gated three ways:

```bash
GOJIRA_ENABLE_ORG_ADMIN=true
GOJIRA_ORG_ADMIN_TOKEN=<admin.atlassian.com API key>
GOJIRA_ORG_ID=<your org id>
GOJIRA_ORG_ADMIN_ACCOUNT_IDS=<comma-separated accountIds allowed to call admin_org tools>
GOJIRA_ENABLED_GROUPS=utility,admin_org
```

`GOJIRA_ORG_ADMIN_ACCOUNT_IDS` is the caller allowlist — **only** these accounts
pass the org-admin gate (empty = deny all; there is no reliable public endpoint to
enumerate org admins, so this is operator-declared and fails closed). The org-admin
group is unverified against a live org in this repo; validate the group
list/get endpoints against your directory type before relying on them.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Consent screen: *"requested scopes that have not been added"* | The app is missing a scope from §3. Add it, save, retry. |
| `401 "scope does not match"` on Assets | Missing **granular** CMDB scope. Add the ones in §3, re-consent. |
| Every `assets.*` tool fails before touching Assets | Workspace discovery (`GET /rest/servicedeskapi/assets/workspace`) is denied — the consent is missing `read:servicedesk-request` (§3). Add it and re-consent. |
| Tool returns `AUTH_REQUIRED … bind an API token` | JSM tool without a bound token — run `gojira.bindApiToken` (§9). |
| `UPSTREAM_UNAVAILABLE` | Transient Atlassian/network issue; the client retries idempotent calls automatically. |
| Automation tools `403` on every call | The bound API token's account is not a Jira administrator. Grant admin (jira-admins group), then **create a fresh token** — tokens minted before the grant keep the old permissions. |
| Automation tools `AUTH_REQUIRED` | Automation uses the per-user API token, not OAuth — run `gojira.bindApiToken` (§9). |
| Redis restart lost tokens | Ensure `appendonly yes` + `maxmemory-policy noeviction` (the shipped compose sets both). |

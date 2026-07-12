# Deploy procedure

End-to-end procedure for getting a fresh gojira-mcp running in
production. Adapt the registry/host references to your infrastructure.

## Prerequisites

- A host that can run Docker Compose (Linux, 2 GB RAM minimum).
- Outbound network access to `*.atlassian.com`, `auth.atlassian.com`,
  `api.atlassian.com`.
- DNS A/AAAA records pointing at the host (if using Caddy).
- The five secrets from [secrets.md](secrets.md) provisioned and
  available out-of-band.
- An Atlassian developer-console OAuth app registered with the right
  redirect URI.

## Step 1 — Register the OAuth app

In the Atlassian developer console:

1. Create a new app (OAuth 2.0 - 3LO).
2. Set the **Callback URL** to `https://<your-host>/oauth/atlassian-callback`.
3. Configure permissions — declare every Atlassian OAuth scope you might
   want this deployment to request. A common minimal set for daily
   admin:
   - `offline_access` (always — required for refresh tokens)
   - `read:me`, `read:account`
   - `read:jira-work`, `write:jira-work`
   - `manage:jira-project`, `manage:jira-configuration`

   Add these only if you enable the Assets groups (`read_assets` /
   `write_assets`) — from **Granular scopes** (CMDB), plus the one JSM
   classic scope the workspace-discovery call needs:
   - `read:cmdb-object:jira`, `write:cmdb-object:jira`,
     `read:cmdb-schema:jira`, `write:cmdb-schema:jira`,
     `read:cmdb-type:jira`, `write:cmdb-type:jira`,
     `read:cmdb-attribute:jira`, `write:cmdb-attribute:jira`
   - `read:servicedesk-request` — for
     `GET /rest/servicedeskapi/assets/workspace`, which every `assets.*`
     call resolves first

   No OAuth scope covers the JSM-admin (`jsm.*`, `forms.*`),
   Confluence-admin, or automation tools: they authenticate with the
   per-user API token bound via `gojira.bindApiToken` (step 7), never
   with an OAuth bearer. Adding `write:servicedesk-request` /
   `manage:servicedesk-customer` for them is dead weight.
4. Save. Copy the **client ID** and **client secret** into your secret
   store.

You can declare a superset of what `ATLASSIAN_OAUTH_SCOPES` will request
— the env var picks the subset to consent for.

## Step 2 — Generate `TOKEN_ENCRYPTION_KEY`

```bash
npm install
npm run generate-key
# captures one line of base64; copy into your secret store
```

Run this on a trusted dev workstation, not on the production host.

## Step 3 — Prepare the host

```bash
ssh prod-host
mkdir -p ~/gojira-mcp && cd ~/gojira-mcp
```

Copy the artifacts:

```bash
# from your dev workstation
scp Dockerfile docker-compose.yml docker-compose.caddy.yml \
    Caddyfile .env.example \
    prod-host:~/gojira-mcp/
```

Or, if your image is already in a registry, you only need the compose
files and Caddyfile.

## Step 4 — Build the env file

On the host:

```bash
cp .env.example .env
$EDITOR .env
```

Populate every required var from [environment-variables.md](environment-variables.md).
At minimum:

```
ATLASSIAN_OAUTH_CLIENT_ID=...
ATLASSIAN_OAUTH_CLIENT_SECRET=...
ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira
ATLASSIAN_PINNED_CLOUD_ID=<cloudId of your prod tenant>
TOKEN_ENCRYPTION_KEY=<base64 from step 2>
ALLOWED_ORIGINS=*
MCP_SERVER_URL=https://gojira.example.com
REDIS_PASSWORD=<random 32-byte hex>
GOJIRA_ENABLED_GROUPS=utility,read_jsm_admin,write_jsm_admin,read_assets,write_assets,read_automation,write_automation,read_customfields,write_customfields,read_projects,write_projects,read_schemes,write_schemes,read_workflows,write_workflows,read_confluence_admin,write_confluence_admin,read_agile,write_agile,read_filters_dashboards,write_filters_dashboards
```

The CMDB + `read:servicedesk-request` scopes above are there because this
allowlist enables `read_assets`/`write_assets`. Drop those groups and you can
drop those scopes with them.

`chmod 600 .env`.

## Step 5 — Bring it up

```bash
# without TLS (you have your own proxy)
docker compose up -d

# with the Caddy overlay
export CADDY_DOMAIN=gojira.example.com
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

The first start triggers an image build (if you didn't push to a
registry); subsequent restarts pull the cached image.

## Step 6 — Verify

```bash
# health
curl -fsS "https://gojira.example.com/health" | jq

# OAuth discovery
curl -fsS "https://gojira.example.com/.well-known/oauth-authorization-server" | jq
```

## Step 7 — Point an MCP client

Open the MCP client (Claude Desktop, VS Code chat, Cursor, Claude Code)
and add a connector at `https://gojira.example.com/mcp`. The client
walks dynamic registration + the OAuth flow automatically.

After the OAuth handshake, call:

```
gojira.whoami
```

You should see your accountId, the deployment's pinned cloudId, and the
list of enabled groups.

For the JSM-admin (`jsm.*`, `forms.*`), Confluence-admin, and automation
tools — the ones that authenticate with the per-user API token rather
than OAuth — each user also calls:

```
gojira.bindApiToken
  email=<yours>@<...>
  token=<generate at id.atlassian.com>
  site_url=<your>.atlassian.net
```

This validates the credential against `/rest/api/3/myself` on that site
and stores it encrypted; it discovers nothing else. Assets tools do
**not** use the bound token — they run on OAuth (CMDB scopes +
`read:servicedesk-request`). For automation, the token's account must be
a **Jira administrator** or every automation call 403s.

## Step 8 — Rotation cadence

- Atlassian client_secret: every 12 months (or per your policy).
- `TOKEN_ENCRYPTION_KEY`: only on suspected compromise (clean cutover
  forces re-auth).
- `GOJIRA_ORG_ADMIN_TOKEN`: every 6 months, on personnel changes.
- `REDIS_PASSWORD`: every 12 months.

## Step 9 — Expand the surface

Only the OAuth-authed groups need scopes at all. Adding **Assets** is the
one expansion that widens `ATLASSIAN_OAUTH_SCOPES`:

```diff
- ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration
+ ATLASSIAN_OAUTH_SCOPES=offline_access read:me read:account read:jira-work write:jira-work manage:jira-project manage:jira-configuration read:servicedesk-request read:cmdb-object:jira write:cmdb-object:jira read:cmdb-schema:jira write:cmdb-schema:jira read:cmdb-type:jira write:cmdb-type:jira read:cmdb-attribute:jira write:cmdb-attribute:jira
```

Make sure those scopes are declared on the Atlassian app, then restart.
Existing bearers stay valid; their next upstream call uses the new
consent set after refresh. New bearers consent fresh.

Adding **Confluence admin**, **JSM admin**, or **automation** needs *no*
scope change — those tools take the per-user API token, so the only
prerequisite is that each user has run `gojira.bindApiToken` (step 7).
Confluence OAuth scopes (`read:confluence-*`, `write:confluence-*`) do
nothing for this deployment; leave them off.

To enable additional permission groups (e.g., add `delete_projects` to
the allowlist):

```diff
- GOJIRA_ENABLED_GROUPS=utility,read_projects,write_projects,...
+ GOJIRA_ENABLED_GROUPS=utility,read_projects,write_projects,delete_projects,...
```

Restart. New sessions register `projects.deleteJiraProject`. Existing
sessions don't pick it up until they call `initialize` again.

## Step 10 — Add `admin_org` (optional)

Deploy a **separate instance** on a different hostname. See
[org-admin-token.md](../oauth/org-admin-token.md) — the security
argument and the env-var changes both.

## See also

- [Docker Compose](docker-compose.md)
- [Caddy TLS overlay](caddy-tls.md)
- [Health checks](health-checks.md)
- [Secrets management](secrets.md)
- [Incident response](../operations/incident-response.md)

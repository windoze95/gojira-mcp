# Operational runbook

Day-2 operations for a running gojira-mcp instance. Setup lives in
[turnkey-setup.md](turnkey-setup.md); this is what you do after go-live.

## Instance layout (prod + non-prod)

One checkout, one compose project per instance, one env file per instance:

```bash
cp deploy/prod.env.example .env.prod         # fill in (fresh secrets, prod cloudId)
cp deploy/nonprod.env.example .env.nonprod   # fill in (sandbox cloudId)

docker compose -p gojira-prod    --env-file .env.prod    -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose -p gojira-nonprod --env-file .env.nonprod -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

- `-p <project>` namespaces containers, networks, and the Redis volume, so the
  two instances never collide.
- `ATLASSIAN_PINNED_CLOUD_ID` differs per file — site pinning refuses any call
  targeting the other tenant, so prod can never touch sandbox and vice versa.
- Changes soak on non-prod first: same image, wider `GOJIRA_ENABLED_GROUPS`;
  prod widens only after the group has proven out.

### Split-profile fleet

The profile fleet is one different deployment, not another prod/non-prod
project. For a fresh install, this repo uses `gojira` as the example:

```bash
docker compose -p gojira -f docker-compose.profiles.yml \
  --env-file deploy/profiles/shared.env up -d --build
```

For upgrades, replace `gojira` with the project name that already owns the
deployment (for example, an existing `gojira-fleet` stack stays
`gojira-fleet`) and use that same name for every upgrade, rollback, backup, and
Redis command. Do not change an existing profile's `MCP_SERVER_URL` or replace
`TOKEN_ENCRYPTION_KEY` during a routine deploy. Those values anchor the Redis
volume, token issuer, and encrypted credential store respectively. Before the
first preflight after this refresh-policy upgrade, merge
`GOJIRA_REFRESH_REUSE_POLICY=contain` (or an intentional `strict` choice) into
the existing `deploy/profiles/shared.env`; do not overwrite the live file from
the example.
Every process sharing that Redis verifies the permanent non-secret marker
`token_encryption_key_fingerprint:v1`; a key mismatch fails startup before the
process listens. Do not delete the marker to bypass a failed deploy.

## Health & monitoring

```bash
curl -fsS https://<host>/health | jq        # {"status":"ok","redis":"ok"}
docker compose -p gojira-prod ps            # container state
docker compose -p gojira-prod logs -f gojira-mcp
```

Watch for:
- `/health` non-200 or `"redis":"degraded"` → check the Redis container first.
- Redis `used_memory` approaching `--maxmemory` (512 MB default). The policy is
  `noeviction` **by design** — the store holds encrypted credentials and the
  operation journal, so at the limit writes fail loudly instead of silently
  evicting tokens. Raise `--maxmemory` before that happens.
- Audit events (`event: tool_call`) are structured JSON on stdout — ship them
  to your SIEM with any log forwarder.
- `REFRESH_TOKEN_REUSE` means strict mode already revoked the family.
  `REFRESH_TOKEN_REUSE_CONTAINED` means contain mode preserved the live
  successor to avoid fleet-wide logout; alert on it immediately and investigate
  the named client because automatic family revocation did not occur.

## Upgrade

```bash
git pull
npm ci && npm run typecheck && npm test     # local gate — same as CI
docker compose -p gojira-nonprod --env-file .env.nonprod up -d --build   # soak
# ... verify non-prod (run `npm run e2e` against the sandbox tenant) ...
docker compose -p gojira-prod --env-file .env.prod up -d --build
```

Rollback = `git checkout <last-good-tag>` and re-run the same `up -d --build`.
The Redis volume is untouched by upgrades; sessions and bound tokens survive.

For the split-profile fleet, use the same deployed `-p` value, Compose file, and
shared env file on both upgrade and rollback. A different project name does not
upgrade the existing fleet; it creates another stack with a different Redis
volume.

### Post-deploy authentication verification

First verify every enabled instance's `/health`; this proves process and Redis
availability only. If the deployment changed auth behavior, or strict mode
returns `invalid_grant`, reauthenticate enabled Codex connections one at a time:

```bash
codex mcp login gojira-readonly
# wait for success before the next login
codex mcp login gojira-service
```

After each login, make a fresh `gojira.whoami` call and one harmless upstream
read exposed by that profile. Do not use `codex mcp list` OAuth `unknown` as the
verdict. Codex OAuth credentials should be persisted in the OS keyring (see the
[profile guide](profiles.md#codex-credential-lifecycle-and-reuse-policy)).

For contained reuse, the stale caller receives retryable OAuth `server_error`
without the successor. Let Codex reread/retry its latest authoritative Keychain
credential first; do not reflexively parallel-login every profile. Investigate
the contained event, then reauthenticate sequentially if the latest credential
cannot be recovered or compromise is plausible.

The MCP RT TTL is rolling 30 days: successful refresh starts another 30-day
window, but a completely idle connection eventually requires login. If
continuity matters, schedule a low-frequency authenticated `gojira.whoami`
roughly every 21 days and alert on failure; keep `/health` as the frequent
service monitor.

## Backup & restore

All persistent state is the Redis volume (AOF): encrypted OAuth tokens, API
token bindings, and the operation journal.

```bash
# Backup (hot; AOF is append-only)
docker run --rm --volumes-from $(docker compose -p gojira-prod ps -q redis) \
  -v "$PWD/backups:/backup" alpine tar czf /backup/redis-$(date +%F).tgz /data

# Restore: stop the stack, replace /data from the tarball, start.
```

Losing the volume is not fatal — users re-consent (OAuth) and re-bind API
tokens — but the operation journal (revert history) is gone. Back it up.

## Secret rotation

| Secret | How to rotate | Blast radius |
|---|---|---|
| `REDIS_PASSWORD` | Update env file + `up -d` (compose passes it to both sides). | None (containers restart). |
| OAuth client secret | Rotate in the Atlassian developer console → update env → `up -d`. | Existing user tokens keep working; new consents use the new secret. |
| `TOKEN_ENCRYPTION_KEY` | Stop every app sharing Redis; re-encrypt or purge `token:*` and `apitoken:*` (and revoke dependent MCP bearer/family state for a clean cutover); delete `token_encryption_key_fingerprint:v1` only then; set the new key everywhere; restart and verify sequential logins. See [secrets management](secrets.md#rotating-token_encryption_key). | All bound credentials; no zero-downtime rotation. |
| Per-user API tokens | Users revoke at id.atlassian.com and re-run `gojira.bindApiToken`. | That user only. |
| Org-admin API key (if enabled) | Rotate at admin.atlassian.com → update the isolated instance's env. | Org-admin tools only. |

## Incident response

Suspected credential abuse or a runaway client:

1. **Stop the surface**: shrink `GOJIRA_ENABLED_GROUPS` (e.g. to `utility`) in
   the env file and `up -d` — takes effect on restart, no data loss.
2. **Cut one user**: revoke their API token at id.atlassian.com and revoke the
   app grant at <https://id.atlassian.com/manage-profile/apps>; their bound
   credentials are useless immediately.
3. **Cut everyone**: follow the stopped-fleet `TOKEN_ENCRYPTION_KEY` rotation
   procedure in [secrets management](secrets.md#rotating-token_encryption_key),
   or delete the Redis volume. Never remove only the fingerprint marker while
   live ciphertext remains.
4. **Audit**: the journal (`gojira.readJournal`, ops `listRecentOperations` / `getOperation`) plus the
   audit log stream reconstruct who did what, with before/after snapshots.
   Mechanically revertible operations can be undone via
   `gojira.revertOperation`.

## Known platform gates (not gojira bugs)

- **Automation tools 403** → the calling user's API token account isn't a Jira
  admin, or the token predates the admin grant (mint a new one).
- **Assets tools 403 "Access to Assets API was denied"** → the site's JSM plan
  is below Premium. Assets requires Premium.
- **`confluence.setContentRestrictions` 403** → Confluence Free; restriction
  writes need a paid plan.
- **SLA config / email channel / portal branding** → no public API at any tier;
  operator does these in the UI (see the
  [capability map](../architecture/jsm-capability-map.md)).

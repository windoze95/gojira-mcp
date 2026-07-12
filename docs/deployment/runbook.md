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
| `TOKEN_ENCRYPTION_KEY` | Generate new key → update env → `up -d`. **Existing encrypted blobs become unreadable**: users must re-consent and re-bind API tokens. Schedule it; announce it. | All bound credentials. |
| Per-user API tokens | Users revoke at id.atlassian.com and re-run `gojira.bindApiToken`. | That user only. |
| Org-admin API key (if enabled) | Rotate at admin.atlassian.com → update the isolated instance's env. | Org-admin tools only. |

## Incident response

Suspected credential abuse or a runaway client:

1. **Stop the surface**: shrink `GOJIRA_ENABLED_GROUPS` (e.g. to `utility`) in
   the env file and `up -d` — takes effect on restart, no data loss.
2. **Cut one user**: revoke their API token at id.atlassian.com and revoke the
   app grant at <https://id.atlassian.com/manage-profile/apps>; their bound
   credentials are useless immediately.
3. **Cut everyone**: rotate `TOKEN_ENCRYPTION_KEY` (all bound credentials
   unreadable at once) or delete the Redis volume.
4. **Audit**: the journal (`gojira.listRecentOperations` / `getOperation`) plus the
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

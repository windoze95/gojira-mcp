# Backup and recovery

What's worth backing up, why, and how to restore.

## What's in Redis

| Class of data | Backup-worthiness |
|---|---|
| `oauth_client:*` (registered MCP clients) | Medium — losing them means clients re-register, which most do automatically. |
| `pending_auth:*`, `atlassian_state:*`, `auth_code:*` | Skip — short TTL (5-10 min), in-flight only. |
| `mcp_token:*`, `mcp_refresh:*`, `rt_family:*`, `refresh_family:*`, `refresh_family_tokens:*` | Low — losing them forces clients to re-`/authorize`, but no permanent data is destroyed. |
| `token:<accountId>` (encrypted Atlassian credentials) | High — losing them forces re-auth across all users. Useless without `TOKEN_ENCRYPTION_KEY`. |
| `apitoken:<accountId>` (encrypted API tokens) | High — same as above. |
| `op_journal:*`, `op_journal_idx:*` | High — operational forensics; cannot be regenerated. |
| `assets_workspace:*` | Skip — 24h cache, regenerable. |
| `org_admin_verified:*` | Skip — 5min cache, regenerable. |
| `ratelimit:*` | Skip — 120s TTL, regenerable. |

Backup priority: `token:*` > `op_journal*` > `apitoken:*` > everything
else.

## Backup mechanism

### Option 1: Redis AOF + RDB snapshots (default)

The compose stack runs Redis with `--appendonly yes`. AOF gives
near-zero data loss on restart. To capture snapshots periodically:

```bash
# host-side cron, daily
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" BGSAVE
sleep 5
docker run --rm \
    -v gojira-mcp_redis-data:/data \
    -v "$(pwd)/backups":/backup \
    alpine \
    sh -c 'cp /data/dump.rdb /backup/dump-$(date +%F).rdb && gzip /backup/dump-$(date +%F).rdb'
```

Retain 30 days locally, longer offsite.

### Option 2: Periodic SCAN export

For more selective backup (e.g., only `token:*` and `op_journal*`):

```bash
#!/bin/bash
set -e
BACKUP_DIR=./backups/$(date +%F)
mkdir -p "$BACKUP_DIR"
for pattern in "token:*" "apitoken:*" "op_journal:*" "op_journal_idx:*"; do
  docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
      --scan --pattern "$pattern" |
  while read -r key; do
    docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" DUMP "$key" \
      > "$BACKUP_DIR/$(echo "$key" | tr / _).dump"
  done
done
tar czf "$BACKUP_DIR.tgz" -C "$BACKUP_DIR" .
rm -rf "$BACKUP_DIR"
```

Restore via `RESTORE <key> 0 <dumped-bytes>`.

### Option 3: Redis replication

If you run a managed Redis (Elasticache, Memorystore, Upstash) you get
replication and point-in-time recovery without effort. The compose
stack assumes the embedded Redis sidecar; for production-grade
operations, externalize Redis to a managed service.

## Backing up `TOKEN_ENCRYPTION_KEY`

The key is the keystone — without it, every backup of `token:*` and
`apitoken:*` is unreadable.

- Store an air-gapped copy in a sealed envelope (KMS, paper safe,
  hardware token). Two principals required to retrieve.
- Never store the key in the same backup blob as the Redis snapshot.
- Don't print, don't email, don't log.

## Backing up `GOJIRA_ORG_ADMIN_TOKEN`

Same treatment. Plus: rotate the token on a 6-month cadence
*regardless* of incident — this limits the blast radius of any
backup that quietly went missing.

## Restore drill

Run quarterly:

1. Spin up a sandbox host.
2. Restore the most recent Redis backup.
3. Restore the encryption key from the air-gapped store.
4. Start a fresh gojira-mcp pointing at the sandbox Redis.
5. Verify:
   ```bash
   curl -fsS http://sandbox/health
   # check that token: keys decrypt by triggering a refresh path:
   # call any tool from a saved-bearer fixture; observe successful upstream call
   ```
6. Tear down.

If the drill fails, the issue is almost always the key — verify it
matches the value at backup time.

## Recovery time objectives

| Scenario | RTO target | Steps |
|---|---|---|
| Service down (process crash) | 30 sec | `docker compose restart` |
| Container OOM-killed | 1 min | `docker compose up -d` after raising memory cap |
| Host failure | 15 min | provision new host, restore .env from secret store, `docker compose up -d` (Redis data loss limited to last AOF flush) |
| Redis volume corruption | 30 min | restore from latest snapshot, restart |
| Total disaster (host + Redis lost) | 2 hours + user re-auth time | provision host, restore key + Redis from offsite, restart, users re-auth as needed |

## See also

- [Secrets management](../deployment/secrets.md) — handling the key
- [Operation journal](../architecture/operation-journal.md) — what's
  worth keeping
- [Incident response](incident-response.md)

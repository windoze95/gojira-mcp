# Secrets management

gojira-mcp depends on five secrets. Misplacing any of them either
breaks the service or compromises encryption-at-rest. Treat them all as
production-tier.

## The secrets

| Secret | Sensitivity | Rotation strategy | Where it lives |
|---|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | **Maximum** — encrypts every stored Atlassian credential. Compromise = read every user's tokens. | Re-encrypt-on-rotate (see below). | Env var (in-memory after start). |
| `ATLASSIAN_OAUTH_CLIENT_SECRET` | High — lets the holder act as gojira-mcp to Atlassian's OAuth endpoint. | Rotate via Atlassian developer console, swap env, restart. | Env var. |
| `GOJIRA_ORG_ADMIN_TOKEN` | **Maximum** — full org-admin authority on `admin.atlassian.com`. Compromise = full org takeover. | Rotate via admin.atlassian.com; both old and new are valid during overlap. | Env var. |
| `REDIS_PASSWORD` (compose only) | Medium — protects the in-cluster Redis from sidecar misconfiguration. | Rotate via `--requirepass` change + restart. | docker-compose env. |
| Per-user Atlassian API tokens | Medium — bound by `gojira.bindApiToken`; only the user themselves can revoke. | Users revoke at id.atlassian.com. | Redis `apitoken:<accountId>` (encrypted at rest by `TOKEN_ENCRYPTION_KEY`). |

## At-rest encryption

`TOKEN_ENCRYPTION_KEY` is the keystone. All of these blobs are AES-256-GCM
encrypted with it:

- `token:<accountId>` — OAuth `StoredToken`
- `apitoken:<accountId>` — per-user API token

Without the key, the blobs are useless to an attacker. Compromise of the
key alone (without Redis access) is also useless. **The two-pronged
compromise** — Redis snapshot + the key — is what's catastrophic.

Generate:

```bash
npm run generate-key
# prints 32 random bytes, base64-encoded
```

The loader rejects keys that don't decode to exactly 32 bytes. Tampered,
malformed, or otherwise unreadable ciphertext fails closed: the encrypted blob
is preserved for recovery/forensics, the caller receives a sanitized
`CREDENTIAL_STORE_UNREADABLE` error, and operators get a credential-kind and
account-scoped warning without ciphertext or key material.

At startup, the first app using a Redis namespace atomically stores a
non-secret HMAC-SHA-256 fingerprint at
`token_encryption_key_fingerprint:v1`. When upgrading a populated namespace
that predates this marker, the first claimant must successfully decrypt every
existing `token:*` and `apitoken:*` blob before it can initialize the marker;
mixed-key or corrupt legacy state fails deterministically for operator repair.
Later processes must present the same `TOKEN_ENCRYPTION_KEY`; a mismatch fails
startup before the HTTP listener is created, so one misconfigured member of a
shared-Redis fleet cannot purge or overwrite credentials. A successful check logs
`TOKEN_ENCRYPTION_KEY_FINGERPRINT_VERIFIED` with state `initialized` or
`matched`, never the key.

## Don't:

- Don't commit secrets to git. `.env` is in `.gitignore`; verify it stays
  that way before any `git add .`.
- Don't log them. The pino redact paths cover `*.token`,
  `*.access_token`, `*.refresh_token`, `*.client_secret`, `*.password`,
  `req.query.token`, `req.headers.authorization`, `req.headers.cookie`.
  But pino redaction is defense in depth — never log them in the first
  place.
- Don't reuse keys across environments. Prod, sandbox, and dev each get
  their own `TOKEN_ENCRYPTION_KEY`.

## Where to store them

| Storage | Suitable for | Notes |
|---|---|---|
| `.env` files | Local dev only | Never on production hosts in plain text. |
| Sealed env files (sops, mozilla/sops + age) | Anywhere; preferred for compose deployments. | Decrypt at start; pass via `env_file:` after `sops -d`. |
| Docker secrets / Kubernetes Secrets | Standard production. | Mount as files; `dotenv` doesn't read them by default — wire via entrypoint script or `cat` into env. |
| AWS Secrets Manager / GCP Secret Manager / HashiCorp Vault | Strongly recommended for `TOKEN_ENCRYPTION_KEY` and `GOJIRA_ORG_ADMIN_TOKEN`. | Pull at container start; cache to env. |
| Hardware HSM | Overkill for now but viable if your security posture requires it. | Would require swapping the in-memory key with an HSM-backed key resolver. |

## Rotating `TOKEN_ENCRYPTION_KEY`

There's no zero-downtime rotation today. Use a stopped-fleet cutover:

1. Generate a new key (`npm run generate-key`) and schedule a maintenance
   window. Users whose blobs are not re-encrypted will need to authenticate and
   bind API tokens again.
2. Stop **every app container that shares the Redis namespace**; keep Redis
   available for the migration. Do not rotate one profile at a time.
3. With the old key still available, either re-encrypt every `token:*` and
   `apitoken:*` blob to the new key using an audited migration, or delete those
   keys for a clean cutover. No dual-key migration is implemented in this repo,
   so deletion and reauthentication are the supported built-in path.
4. For a clean cutover, also revoke the `mcp_token:*`, `mcp_refresh:*`,
   `mcp_refresh_replay:*`, `mcp_refresh_reuse_notice:*`, `refresh_family:*`,
   `refresh_family_tokens:*`, `rt_family:*`, and `rt_family_account:*` state
   that points at the removed upstream credentials.
5. Only after the encrypted blobs have been re-encrypted or purged, delete the
   permanent `token_encryption_key_fingerprint:v1` marker. Removing this marker
   by itself is not a recovery procedure; it disables the mismatch guard.
6. Set the new `TOKEN_ENCRYPTION_KEY` identically for every app container, then
   restart the fleet. The first process claims the new fingerprint and the rest
   must match it before listening.
7. Verify the startup event and complete sequential login, `gojira.whoami`, and
   harmless-read checks for every enabled profile.

Roadmap candidate.

## Rotating `ATLASSIAN_OAUTH_CLIENT_SECRET`

1. Atlassian developer console → rotate secret. Atlassian supports a
   short overlap window.
2. Update the env var on the server.
3. Restart.
4. Existing user sessions continue working (their MCP bearer is fine);
   the upstream refresh flow uses the new secret on next refresh.

## Rotating `GOJIRA_ORG_ADMIN_TOKEN`

1. admin.atlassian.com → generate a new org-admin token.
2. Update the env var on the org-admin instance.
3. Restart.
4. Revoke the old token.

No in-memory hot reload; the secret is read at process start.

## Backup considerations

Backing up Redis without also backing up `TOKEN_ENCRYPTION_KEY` is
**useless** — the encrypted token blobs are unrecoverable. Conversely,
backing up the key without Redis is fine (no user data).

For disaster recovery: store the key alongside an air-gapped copy
sealed with your KMS, and back up Redis nightly. See
[backup.md](../operations/backup.md).

## See also

- [Environment variables](environment-variables.md)
- [Deploy procedure](deploy-procedure.md)
- [Backup and recovery](../operations/backup.md)
- `src/auth/encryption.ts` — algorithm details

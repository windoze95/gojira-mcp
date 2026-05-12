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

The loader rejects keys that don't decode to exactly 32 bytes. Tampering
with the resulting ciphertext (or using the wrong key) fails closed:
`decrypt()` throws, and `getToken()` purges the corrupt blob automatically.

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

There's no zero-downtime rotation today. The pragmatic path:

1. Generate a new key (`npm run generate-key`).
2. Decide on the rotation window. Users will need to re-authenticate
   for OAuth tokens encrypted under the **old** key — pick a low-traffic
   window or accept temporary disruption.
3. Option A — **clean cutover** (recommended): set the new key, restart
   the service, delete `token:*` and `apitoken:*` from Redis (clients
   re-auth). This is the safest path; no risk of stale ciphertext.
4. Option B — **dual-key transition** (not implemented): would require
   extending `encryption.ts` with `decryptWithFallback(blob, primary,
   secondaries[])` and writing a background re-encrypt job. Out of scope
   for v0.

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

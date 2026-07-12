#!/usr/bin/env bash
#
# gojira-mcp preflight — validate a deployment's configuration BEFORE go-live.
# Reads the .env in the current directory (or $ENV_FILE). Non-destructive.
#
#   ./scripts/preflight.sh              # validate ./.env
#   ENV_FILE=/path/.env ./scripts/preflight.sh
#   ./scripts/preflight.sh --health https://gojira.example.com   # also ping /health
#
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
HEALTH_URL=""
if [[ "${1:-}" == "--health" ]]; then HEALTH_URL="${2:-}"; fi

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()   { printf '\033[33m%s\033[0m\n' "$*"; }
fail=0; warn=0

if [[ ! -f "$ENV_FILE" ]]; then red "✗ env file not found: $ENV_FILE"; exit 1; fi
# Parse dotenv line-by-line — values may contain spaces and must NOT be run as
# shell (so no `source`). Split on the first '=', strip optional surrounding quotes.
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "${line#"${line%%[![:space:]]*}"}" == \#* ]] && continue
  [[ "$line" != *"="* ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  key="${key//[[:space:]]/}"
  [[ "$val" == \"*\" ]] && val="${val#\"}" && val="${val%\"}"
  [[ "$val" == \'*\' ]] && val="${val#\'}" && val="${val%\'}"
  export "$key=$val"
done < "$ENV_FILE"

need() { # need VAR "human hint"
  if [[ -z "${!1:-}" ]]; then red "✗ $1 is required — $2"; fail=1; else grn "✓ $1 set"; fi
}
warn_if() { # warn_if CONDITION "message"
  if eval "$1"; then ylw "⚠ $2"; warn=1; fi
}

echo "── Required ─────────────────────────────────────────"
need ATLASSIAN_OAUTH_CLIENT_ID   "from the Atlassian developer console OAuth app"
need ATLASSIAN_OAUTH_CLIENT_SECRET "from the same OAuth app"
need ATLASSIAN_OAUTH_SCOPES      "space-separated scopes (must include offline_access)"
need TOKEN_ENCRYPTION_KEY        "run: npm run generate-key"
need ALLOWED_ORIGINS             "'*' for dev, explicit origins for prod"
need GOJIRA_ENABLED_GROUPS       "comma-separated permission groups"

echo "── Scope sanity ─────────────────────────────────────"
case "${ATLASSIAN_OAUTH_SCOPES:-}" in
  *offline_access*) grn "✓ offline_access present (refresh tokens will work)";;
  *) red "✗ ATLASSIAN_OAUTH_SCOPES must include offline_access"; fail=1;;
esac

# Encryption key must base64-decode to exactly 32 bytes.
if [[ -n "${TOKEN_ENCRYPTION_KEY:-}" ]]; then
  bytes=$(printf '%s' "$TOKEN_ENCRYPTION_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ' || echo 0)
  if [[ "$bytes" == "32" ]]; then grn "✓ TOKEN_ENCRYPTION_KEY decodes to 32 bytes"
  else red "✗ TOKEN_ENCRYPTION_KEY must base64-decode to 32 bytes (got ${bytes}); run: npm run generate-key"; fail=1; fi
fi

echo "── Group ↔ scope cross-checks ───────────────────────"
# "a, b, c" is a perfectly normal way to write the list — strip whitespace so a
# match still lands. Without this every has() below silently returns false and
# the whole section passes a misconfigured deployment.
grp="${GOJIRA_ENABLED_GROUPS:-}"
grp="${grp//[[:space:]]/}"
scp="${ATLASSIAN_OAUTH_SCOPES:-}"
has() { [[ ",$grp," == *",$1,"* ]]; }
scope_has() { [[ " $scp " == *" $1 "* ]]; }
check_scope() { # check_scope GROUP SCOPE
  if has "$1" && ! scope_has "$2"; then ylw "⚠ group '$1' is enabled but scope '$2' is not in ATLASSIAN_OAUTH_SCOPES"; warn=1; fi
}
# Confluence admin tools ride the per-user API token (site host, Basic) — no
# OAuth scopes needed; nothing to check here.
check_scope read_assets            "read:cmdb-object:jira"    # Assets needs CMDB granular scopes
check_scope write_assets           "write:cmdb-object:jira"
check_scope read_jsm_admin         "read:servicedesk-request"
check_scope read_workflows         "manage:jira-configuration"
if has read_automation || has write_automation; then
  ylw "ℹ automation groups enabled: automation tools need a bound per-user API token"
  ylw "  (gojira.bindApiToken) whose account is a Jira administrator — no OAuth scope"
  ylw "  covers automation. Non-admin accounts get 403 on every automation call."
fi

echo "── Production posture ───────────────────────────────"
warn_if '[[ "${NODE_ENV:-}" != "production" ]]' "NODE_ENV is not 'production' (dev logger may crash in a pruned image)"
warn_if '[[ "${ALLOWED_ORIGINS:-}" == "*" ]]' "ALLOWED_ORIGINS='*' — set explicit origins for production (disables credentialed CORS)"
warn_if '[[ "${MCP_SERVER_URL:-}" == http://* ]]' "MCP_SERVER_URL is plain http — front it with TLS (Caddy) for production"
# The server's config parser (src/config.ts) accepts true/1/yes, case-insensitive.
# Checking only for the literal "true" here would skip these required-var checks
# on a deployment that the server does treat as org-admin-enabled.
org_admin="${GOJIRA_ENABLE_ORG_ADMIN:-false}"
org_admin="$(printf '%s' "${org_admin//[[:space:]]/}" | tr '[:upper:]' '[:lower:]')"
if [[ "$org_admin" == "true" || "$org_admin" == "1" || "$org_admin" == "yes" ]]; then
  need GOJIRA_ORG_ADMIN_TOKEN "org-admin API token"
  need GOJIRA_ORG_ID "org id"
  need GOJIRA_ORG_ADMIN_ACCOUNT_IDS "comma-separated admin accountIds (fails closed if empty)"
fi

if [[ -n "$HEALTH_URL" ]]; then
  echo "── Liveness ─────────────────────────────────────────"
  if curl -fsS "${HEALTH_URL%/}/health" >/tmp/gojira_health 2>/dev/null && grep -q '"status":"ok"' /tmp/gojira_health; then
    grn "✓ ${HEALTH_URL%/}/health is ok"
  else red "✗ ${HEALTH_URL%/}/health not ok"; fail=1; fi
fi

echo "─────────────────────────────────────────────────────"
if [[ "$fail" == "1" ]]; then red "PREFLIGHT FAILED — fix the ✗ items above."; exit 1; fi
if [[ "$warn" == "1" ]]; then ylw "Preflight passed with warnings (⚠). Review before go-live."; else grn "Preflight passed."; fi

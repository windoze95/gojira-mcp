#!/usr/bin/env bash
#
# gojira-mcp fleet preflight — validate a split-surface profile deployment
# (docker-compose.profiles.yml) BEFORE go-live. Non-destructive.
#
# Runs the single-instance preflight against every profile's merged env
# (shared.env + <profile>.env, later wins — same precedence as compose
# env_file), then checks the CROSS-PROFILE invariants: fleet-shared values
# must be identical, instance names distinct, at most one org-admin profile.
#
#   ./scripts/preflight-profiles.sh          # validates deploy/profiles/*.env
#
set -euo pipefail

DIR="deploy/profiles"
SHARED="$DIR/shared.env"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
grn()   { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()   { printf '\033[33m%s\033[0m\n' "$*"; }
fail=0; warn=0

if [[ ! -f "$SHARED" ]]; then
  red "✗ $SHARED not found — cp ${SHARED}.example $SHARED and fill it in"
  exit 1
fi

profiles=()
for f in "$DIR"/*.env; do
  [[ -e "$f" ]] || continue
  [[ "$f" == "$SHARED" ]] && continue
  profiles+=("$f")
done
if [[ ${#profiles[@]} -eq 0 ]]; then
  red "✗ no profile env files in $DIR — copy the ones you deploy, e.g.:"
  red "    cp $DIR/readonly.env.example $DIR/readonly.env"
  exit 1
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# Last assignment wins — mirrors both compose env_file precedence and
# preflight.sh's sequential-export parser.
getvar() { # getvar FILE VAR
  local line val
  line=$(grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -n 1 || true)
  if [[ -z "$line" ]]; then printf ''; return; fi
  val="${line#*=}"
  [[ "$val" == \"*\" ]] && val="${val#\"}" && val="${val%\"}"
  [[ "$val" == \'*\' ]] && val="${val#\'}" && val="${val%\'}"
  printf '%s' "$val"
}

is_truthy() {
  local v
  v=$(printf '%s' "${1:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  [[ "$v" == "true" || "$v" == "1" || "$v" == "yes" ]]
}

# ── Per-profile: run the single-instance preflight on the merged env ──────────
for pfile in "${profiles[@]}"; do
  name=$(basename "$pfile" .env)
  merged="$tmpdir/$name.merged.env"
  cat "$SHARED" "$pfile" > "$merged"
  echo
  echo "══ profile: $name ══════════════════════════════════"
  if ! ENV_FILE="$merged" bash scripts/preflight.sh; then
    fail=1
  fi
done

echo
echo "══ fleet invariants ════════════════════════════════"

# Fleet-shared values must be identical everywhere (they live in shared.env;
# a profile file overriding one is exactly the drift this catches).
for var in TOKEN_ENCRYPTION_KEY ATLASSIAN_OAUTH_CLIENT_ID ATLASSIAN_OAUTH_CLIENT_SECRET \
           ATLASSIAN_OAUTH_SCOPES ATLASSIAN_CALLBACK_URI ATLASSIAN_PINNED_CLOUD_ID; do
  ref=""; refname=""; bad=0
  for pfile in "${profiles[@]}"; do
    name=$(basename "$pfile" .env)
    v=$(getvar "$tmpdir/$name.merged.env" "$var")
    if [[ -z "$refname" ]]; then ref="$v"; refname="$name"; continue; fi
    if [[ "$v" != "$ref" ]]; then
      red "✗ $var differs between '$refname' and '$name' — fleet invariants must be identical (set them only in shared.env)"
      fail=1; bad=1
    fi
  done
  [[ "$bad" == "0" ]] && grn "✓ $var identical across profiles"
done

# Instance names: present and pairwise distinct.
seen=","
for pfile in "${profiles[@]}"; do
  name=$(basename "$pfile" .env)
  inst=$(getvar "$tmpdir/$name.merged.env" "GOJIRA_INSTANCE_NAME")
  if [[ -z "$inst" ]]; then
    red "✗ $name: GOJIRA_INSTANCE_NAME is missing — each profile must name itself"
    fail=1
    continue
  fi
  if [[ "$seen" == *",$inst,"* ]]; then
    red "✗ GOJIRA_INSTANCE_NAME '$inst' is used by more than one profile"
    fail=1
  fi
  seen="$seen$inst,"
done
[[ "$fail" == "0" ]] && grn "✓ GOJIRA_INSTANCE_NAME present and distinct"

# Every profile needs utility (health/whoami/bindApiToken/journal live there).
for pfile in "${profiles[@]}"; do
  name=$(basename "$pfile" .env)
  grp=$(getvar "$tmpdir/$name.merged.env" "GOJIRA_ENABLED_GROUPS")
  grp="${grp//[[:space:]]/}"
  if [[ ",$grp," != *",utility,"* ]]; then
    red "✗ $name: GOJIRA_ENABLED_GROUPS does not include 'utility' — nothing auto-injects it"
    fail=1
  fi
done

# At most one org-admin profile; flag ↔ group asymmetry is a footgun either way.
orgcount=0
for pfile in "${profiles[@]}"; do
  name=$(basename "$pfile" .env)
  merged="$tmpdir/$name.merged.env"
  flag=$(getvar "$merged" "GOJIRA_ENABLE_ORG_ADMIN")
  grp=$(getvar "$merged" "GOJIRA_ENABLED_GROUPS"); grp="${grp//[[:space:]]/}"
  has_group=0; [[ ",$grp," == *",admin_org,"* ]] && has_group=1
  if is_truthy "$flag"; then
    orgcount=$((orgcount + 1))
    if [[ "$has_group" == "0" ]]; then
      ylw "⚠ $name: GOJIRA_ENABLE_ORG_ADMIN=true but 'admin_org' is not in GOJIRA_ENABLED_GROUPS — the flag is inert"
      warn=1
    fi
  elif [[ "$has_group" == "1" ]]; then
    ylw "⚠ $name: 'admin_org' is enabled but GOJIRA_ENABLE_ORG_ADMIN is not true — the tools register nowhere"
    warn=1
  fi
done
if [[ "$orgcount" -gt 1 ]]; then
  red "✗ $orgcount profiles enable org admin — keep the Cloud-Admin-token blast radius on exactly one instance"
  fail=1
fi

# The shared callback must live on the host clients actually reach.
cb=$(getvar "$SHARED" "ATLASSIAN_CALLBACK_URI")
host=$(getvar "$SHARED" "GOJIRA_HOST")
if [[ -n "$cb" && -n "$host" && "$cb" != *"$host"* ]]; then
  ylw "⚠ ATLASSIAN_CALLBACK_URI ($cb) does not contain GOJIRA_HOST ($host) — the Atlassian redirect will miss the fleet"
  warn=1
fi
# The callback anchor is the readonly instance's port in the shipped layout.
if [[ ! -f "$DIR/readonly.env" && -n "$cb" && "$cb" == *":8081/"* ]]; then
  ylw "⚠ callback is anchored on :8081 (readonly) but $DIR/readonly.env does not exist — consents will dead-end while that instance is absent"
  warn=1
fi

# MCP SDK issuer rule: http issuers are only accepted for localhost/127.0.0.1;
# anything else needs the explicit opt-out or https, or every container
# crash-loops at startup with "Issuer URL must be HTTPS".
scheme=$(getvar "$SHARED" "GOJIRA_URL_SCHEME"); scheme="${scheme:-http}"
insecure=$(getvar "$SHARED" "MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL")
if [[ "$scheme" == "http" && -n "$host" && "$host" != "localhost" && "$host" != "127.0.0.1" ]]; then
  if is_truthy "$insecure"; then
    ylw "⚠ plain-http issuers on '$host' (MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL) — bearer tokens travel unencrypted; keep that network truly private"
    warn=1
  else
    red "✗ GOJIRA_HOST '$host' over http: the MCP SDK refuses non-localhost http issuers — set MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true (variant B) or go https (variant C); see shared.env.example"
    fail=1
  fi
fi
if [[ "$scheme" == "https" && -z "$(getvar "$SHARED" "TLS_CERT_PATH")" ]]; then
  red "✗ GOJIRA_URL_SCHEME=https but TLS_CERT_PATH is unset — in-process TLS needs cert+key in deploy/profiles/certs/ (variant C)"
  fail=1
fi

echo "─────────────────────────────────────────────────────"
if [[ "$fail" == "1" ]]; then red "FLEET PREFLIGHT FAILED — fix the ✗ items above."; exit 1; fi
if [[ "$warn" == "1" ]]; then ylw "Fleet preflight passed with warnings (⚠). Review before go-live."; else grn "Fleet preflight passed."; fi

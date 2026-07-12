# JSM admin capability map (verified)

What of the JSM/Jira admin surface is reachable programmatically — and by which
channel. **Every row was tested live** against a real tenant with an admin API
token (Basic auth = full permissions), so a 404 means "no REST endpoint exists,"
not "wrong scope."

Legend: **REST‑OAuth** = per‑user OAuth 3LO · **REST‑token** = per‑user admin API
token (Basic auth; reaches more admin than OAuth) · **Forge** = requires a
Connect/Forge app credential · **UI** = no public API at any auth level.

## ✅ Reachable — shipped or wireable as gojira tools

| Capability | Channel | Notes |
|---|---|---|
| Analyze incidents/requests (detail, status, transitions, approvals, comments) | REST‑OAuth / token | all 200 |
| Read logs / history (issue changelog, SLA **state**) | REST‑OAuth / token | 200 |
| JQL search across issues/requests | REST‑OAuth / token | 200 |
| Request types — list/get/**create**/**delete** | **REST‑token** | create=201, delete=204 via the admin API token; OAuth 401s. gojira's JSM tools already use the token path. |
| Request‑type fields & groups (read) | REST‑token | 200 |
| Queues — list/get/issues | REST‑token | read‑only (create/update/delete = 405) |
| Organizations & customers — list/add/remove | REST‑token | 200 |
| Knowledge‑base article search | REST‑token | 200 |
| Workflow transition rules (conditions/validators/post‑functions) | REST‑OAuth | new workflow API; wired in the workflow rewrite |
| Assets / CMDB | REST‑OAuth | needs the `cmdb-*:jira` granular scopes |
| Confluence spaces/pages | REST‑OAuth | needs granular `space`/`page` scopes |
| **Portal request forms + IT‑support forms** | REST‑OAuth | JSM **Forms API** (`api.atlassian.com/jira/forms/cloud/{cloudId}`) — endpoint exists (401 = needs the Forms scope). Wireable once the scope is added. |

## ✅ Automation rules — reachable via REST (corrected finding)

Earlier this was listed as "Forge only." That was **wrong** — it failed because I
used the wrong credential. Verified live:

- The GA **Automation Rule Management API** (`api.atlassian.com/automation/public/jira/{cloudId}/rest/v1`)
  is on the `api.atlassian.com` host but authenticates with the per-user **API
  token via Basic auth** (`email:token`) — the same `api_token` mode the JSM
  tools use. NOT OAuth 3LO (a 3LO token gets `401 scope does not match`; there is
  no automation OAuth scope), and NOT the token as a Bearer (→ 403).
- Verified live against the dev tenant — **full lifecycle**: `POST /rule` →
  **201** `{ruleUuid}` · `GET /rule/summary` → 200 · `GET /rule/{uuid}` → 200
  (exports the full rule config) · `PUT /rule/{uuid}/state` → 200 ·
  `DELETE /rule/{uuid}` → 200 → subsequent GET 404 · `POST /template/search`,
  `GET /template/{id}`, `POST /template/create` → 200 (created a real rule from
  `itsm_template_38`-class templates).
- Contract gotchas the OpenAPI spec hides: the state body is
  `{ "value": "ENABLED"|"DISABLED" }` (a `{state}` key 400s), and DELETE 400s on
  an ENABLED rule ("Rule cannot be deleted unless it is already disabled") — so
  delete flows must disable first. Component `value` shapes are undocumented; the
  practical authoring path is create-from-template (or UI), export via
  `GET /rule/{uuid}`, and adapt.
- The one requirement: the token's account must be a **Jira administrator** (holds
  the `ADMINISTER` global permission). A non-admin account 403s on every call, and
  a token minted *before* the admin grant keeps its stale permissions — grant
  first, then create the token.

gojira's `automation.*` tools use the bound API token via Basic auth against these
endpoints. **No Forge app is required.**

## ❌ NOT reachable by any credential (UI-only)

Verified 404 with a full-permission admin token and no matching scope:

| Capability | Reality | Only viable path |
|---|---|---|
| **SLA goal/calendar configuration** | 404. No REST endpoint. (SLA *state* per request is readable.) | UI, or possibly ScriptRunner. |
| **Email-to-request channel** setup | 404. No REST endpoint. | UI. |
| **Portal branding / settings** | 404. No REST endpoint. | UI. |

## Why UI automation isn't a clean fix

Driving the JSM admin UI from an unattended server (Playwright/headless) hits a
hard wall: it needs a logged‑in **Atlassian admin session** (email + password +
2FA/OTP). A server can't safely hold those, and storing admin credentials for
UI login is both fragile and a security liability. So the UI‑only rows are
genuinely **operator‑in‑the‑loop** tasks, not autonomous ones.

## Recommendation

1. **Ship the verified REST core** (everything in the ✅ table) — this is the bulk
   of daily JSM admin and it works today.
2. **Wire the Forms tools** (add the Forms scope; the API is there).
3. **Automation rules → the REST tools already in gojira** (`automation.*`). The
   operator binds an API token whose account is a Jira admin. **No Forge app.**
4. **SLA config / email channel / portal branding → operator‑guided.** gojira can
   *read* and *validate* these and generate precise setup steps; a human applies
   them in the UI. These are rare one‑time setup tasks.

The honest bottom line: **~90% of "everything in JSM" is reliable API today —
including automation rules — leaving only a handful of one‑time UI tasks (SLA
config, email channel, portal branding) that no integration can safely automate
unattended.**

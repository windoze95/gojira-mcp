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

## ❌ NOT reachable by any credential gojira can hold

Verified 404 with a full‑permission admin token **and** no matching OAuth scope:

| Capability | Reality | Only viable path |
|---|---|---|
| **Automation rules** ("business rules") | The automation public API rejects both OAuth (no scope exists — checked all 399 granular Jira scopes) and the admin API token (404 on every host). | A **Forge/Connect app** (authenticates as an app, not a user). |
| **SLA goal/calendar configuration** | 404. No REST endpoint. (SLA *state* per request is readable.) | UI, or possibly ScriptRunner. |
| **Email‑to‑request channel** setup | 404. No REST endpoint. | UI. |
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
3. **Automation rules → a Forge companion app** — the one reliable programmatic
   path. Deployed per org, it authenticates as an app and can manage automation.
   A real follow‑up project, not a gojira REST tool.
4. **SLA config / email channel / portal branding → operator‑guided.** gojira can
   *read* and *validate* these and generate precise setup steps; a human applies
   them in the UI. These are rare one‑time setup tasks.

The honest bottom line: **~80% of "everything in JSM" is reliable API today; the
rest is a Forge app (automation) plus a handful of one‑time UI tasks that no
integration can safely automate unattended.**

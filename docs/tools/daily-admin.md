# Daily admin tools

Day-to-day Atlassian Cloud admin: JSM service-desk configuration,
Assets/Insight CMDB, Jira automation rules, custom fields, and the safe
project-management surface (create + archive; delete is in its own group
covered in [schemes-and-workflows.md](schemes-and-workflows.md)).

25 tools carrying 71 operations across 10 permission groups. Most are
op-parameterized — one tool, several operations selected by a required
`op` field, called as `{ "op": "…", …args }`. The auto-generated
[catalog](catalog.md) has every input schema.

## JSM admin (`read_jsm_admin` / `write_jsm_admin`)

**Credential:** API token side-channel (`gojira.bindApiToken` must be
called first per user).

### `jsm.readServiceDesk` — desks and request types

`listServiceDesks` (paginated via `start`/`limit`),
`getServiceDesk(serviceDeskId)`, `listRequestTypes` (optionally scoped to
a request-type `groupId`), `getRequestType`, `getRequestTypeFields` (the
field set behind a request type), and `getRequestTypeGroups`.

### `jsm.readSupport` — queues, SLA state, organizations, KB

| op | Notes |
|---|---|
| `listQueues`, `getQueue`, `getQueueIssues` | read-only — the public API has no queue writes |
| `getRequestSla` | keyed by ISSUE (`issueIdOrKey`), not by desk. Per-request SLA *state* only; goal *configuration* has no public API (see the [capability map](../architecture/jsm-capability-map.md)) |
| `listJsmOrganizations` | global when `serviceDeskId` is omitted |
| `searchKnowledgeBaseArticles` | article *linking* is UI-only |

### `jsm.manage` — additions (destructive, `commit`-gated)

- `createRequestType(serviceDeskId, issueTypeId, name, description?, helpText?)`
  — revertible; the revert deletes the created type.
- `addCustomersToOrganization(organizationId, accountIds?/usernames?)` —
  conditionally revertible; removes only the customers it actually added.

### `jsm.delete` — removals (destructive, `commit`-gated)

- `deleteRequestType(serviceDeskId, requestTypeId)` — **irreversible**.
- `removeCustomersFromOrganization(organizationId, accountIds?/usernames?)`
  — conditionally revertible; re-adds only the customers it actually removed.

Both membership ops snapshot the organization's members around the
mutation and journal the diff; the revert acts on that diff, not on the
submitted list, because submitting an existing member is a no-op for them
and reverting the whole list would evict someone the call never added. The
diff is also what makes a `usernames`-keyed call revertible at all —
Atlassian privacy settings routinely redact `emailAddress` from the
membership list, but accountIds show up in the diff. If the membership
can't be read, the op journals `revertible: false` rather than guess.

> Earlier versions also shipped queue/SLA/portal *write* tools — those called
> endpoints that don't exist in Atlassian Cloud and were removed. What remains
> is the live-verified surface; portal branding, SLA config, and the email
> channel are UI-only (capability map).

## Forms (`read_jsm_admin` / `write_jsm_admin`)

**Credential:** the same bound API token — the Forms API's Basic-auth host
(`api.atlassian.com/jira/forms/cloud/{cloudId}`) needs no OAuth scope.
Full template lifecycle verified live.

### `forms.read`

- `listFormTemplates(projectIdOrKey)` — portal request forms / intake forms.
- `getFormTemplate(projectIdOrKey, formId)` — includes the full `design`
  document (export/adapt).
- `getRequestTypeForm(serviceDeskId, requestTypeId)` — 404 if the request
  type has no form.
- `listIssueForms(issueIdOrKey)` — agent view of an issue's forms.
- `getIssueFormAnswers(issueIdOrKey, formId)` — `formId` here is the ISSUE
  form id, not the template id.

### `forms.manageTemplate` — destructive, `commit`-gated, both revertible

- `createFormTemplate(projectIdOrKey, form)` — `form` must carry a `design`
  document; export one with `forms.read` `getFormTemplate` for the shape.
- `updateFormTemplate(projectIdOrKey, formId, form)` — replace in place,
  full before/after; attach to portal request types via
  `portalRequestTypeIds`.

### `forms.delete`

Single-op tool, so no `op` field: `{ projectIdOrKey, formId, commit: true }`.
**Irreversible** — the full template, design included, is captured in the
journal `before`.

## Assets / Insight (`read_assets` / `write_assets`)

**Credential:** OAuth, with the CMDB granular scopes — *not* the API
token side-channel. Every `assets.*` tool is `authMethod: "oauth"`, and
the workspace-id discovery step that precedes each call is OAuth too, so
a bound API token alone is insufficient (discovery raises
`AUTH_REQUIRED`).

Assets is a **Premium** JSM feature. On a non-Premium site these tools
403 — that is a licensing limit, not a bug.

- `assets.readSchema` — `listObjectSchemas`, `getObjectSchema(schemaId)`,
  `listObjectTypes(schemaId)` and `getObjectTypeAttributes(objectTypeId)`
  (the id is the PARENT in both), `getObjectType`, and
  `exportAssetSchema(schemaId)`, which emits schema + types + attributes
  as one JSON — useful as a backup before destructive ops.
- `assets.readObject` — `getObject`, `getObjectReferences`,
  `getObjectHistory`, all by `objectId`.
- `assets.aqlSearch(qlQuery, page?, resultPerPage?, includeAttributes?)` —
  single-op, so no `op` field.
- `assets.manageSchema` — destructive, `commit`-gated. Create/update pairs
  for the three modelling levels: `createObjectSchema` /
  `updateObjectSchema`, `createObjectType` / `updateObjectType`,
  `createObjectTypeAttribute` / `updateObjectTypeAttribute`. The updates
  are revertible, the creates are not. `createObjectType` requires
  `iconId` (ids from `GET /icon/global`), and `updateObjectTypeAttribute`
  requires `objectTypeId`: it is part of the path, not just a lookup hint.
- `assets.manageObject` — destructive, `commit`-gated:
  `createObject(objectTypeId, attributes[], hasAvatar?)` and
  `updateObject(objectId, attributes[])`, the update revertible and
  restoring the prior values of exactly the attributes it touched.
- `assets.delete` — destructive, `commit`-gated, every op
  **irreversible**. `deleteObjectSchema` cascades to every type and object
  in the schema (the whole definition lands in the journal `before`, but
  export it first); `deleteObjectType` takes the type and its objects;
  `deleteObject` takes one object; `deleteObjectTypeAttribute` journals the
  object type's *full* attribute list, because no single-attribute GET
  exists to reconstruct from.
- `assets.startImport(importId)` — single-op, irreversible.

References are **read-only**. There is no add/remove-reference tool
because there is no such endpoint: a reference is expressed as an
attribute value, so you create or drop one by writing the referencing
attribute through `assets.manageObject`.

`startImport` triggers a **pre-configured** import by its id. The import
itself (source, mapping, schedule) is configured in the Assets UI; the
API only starts it. There is no CSV-upload endpoint — you cannot hand
gojira a CSV and have it ingested.

## Automation rules (`read_automation` / `write_automation`)

**Credential:** API token side-channel (`gojira.bindApiToken` must be
called first per user). The token's account must be a **Jira
administrator** — a non-admin token gets 403 on every automation call,
and a token created *before* the admin grant keeps its stale
permissions, so create the token after the grant. No Forge or Connect
app is involved: the tools call
`api.atlassian.com/automation/public/jira/{cloudId}/rest/v1` directly.

- `automation.readRule` — `listAutomationRules(cursor?, limit?)` for
  cursor-paged summaries, `getAutomationRule(ruleId)` for one full rule by
  UUID.
- `automation.readTemplate` — `searchAutomationTemplates(payload?)` (pass
  `{}` for all) and `getAutomationTemplate(templateId)`.
- `automation.searchManualRules(payload)` — single-op; manually-triggerable
  rules for a given object (e.g. an issue).
- `automation.manageRule` — destructive, `commit`-gated, all revertible:
  `createAutomationRule(rule)` (revert = disable, then delete by UUID),
  `updateAutomationRule(ruleId, rule)` (full before/after — rule JSON does
  not patch cleanly), `enableAutomationRule` / `disableAutomationRule`
  (restore the captured prior state).
- `automation.createRuleFromTemplate(templateId, ruleHome, parameters?)` —
  single-op, revertible the same way. `ruleHome` is the scope ARI, e.g.
  `ari:cloud:jira:{cloudId}:project/{projectId}`.
- `automation.delete(ruleId)` — single-op, destructive, **irreversible**.
  Disables the rule first (the API rejects deleting an enabled rule) and
  re-enables it if the delete fails.

## Custom fields (`read_customfields` / `write_customfields`)

**Credential:** OAuth.

- `customfields.read` — `listCustomFields(startAt?, maxResults?, query?,
  type[]?, id[]?)`, `getCustomField(fieldId, includeContexts?)`,
  `listCustomFieldContexts(fieldId, startAt?, maxResults?)` (page size
  caps at 100).
- `customfields.manage` — destructive, `commit`-gated:
  `createCustomField(name, type, description?, searcherKey?)` and
  `updateCustomField(fieldId, …)` are revertible, as is
  `assignCustomFieldToProjects(fieldId, contextId, projectIds[])` (the
  revert removes the same project ids). `setCustomFieldOptions(fieldId,
  contextId, options[])` is **not** revertible — see below.
- `customfields.delete` — single-op: `{ fieldId, commit: true }`.
  **Irreversible**, and may detach values from issues.

`setCustomFieldOptions` is an upsert, not a replace: Jira splits the two
verbs, so options *with* an `id` are PUT (update in place) and options
*without* one are POST (create). Nothing is ever deleted. That is
exactly why it journals `revertible: false` — re-applying the captured
`before` would restore the edited options but could not remove the ones
the call created. The `before` snapshot is still captured for a manual
cleanup.

## Projects (`read_projects` / `write_projects`)

**Credential:** OAuth. Project deletion is a separate opt-in tool,
`projects.delete`, in its own permission group — see the *Delete
projects* section of
[schemes-and-workflows.md](schemes-and-workflows.md).

- `projects.read` — `listJiraProjects(startAt?, maxResults?, expand[]?,
  query?, typeKey?, orderBy?)` (admin view),
  `getJiraProject(project, expand[]?)`, and
  `getJiraProjectDetails(project)`, which adds components, roles, and
  notification-scheme assignments in one call.
- `projects.manage` — destructive, `commit`-gated:
  `createJiraProject(key, name, projectTypeKey, leadAccountId,
  projectTemplateKey?, description?, assigneeType?, url?)` is not
  auto-revertible; `archiveJiraProject(project)` is revertible via
  restore.

## See also

- [Schemes and workflows](schemes-and-workflows.md) — including the isolated `delete_projects` group
- [Agile and views](agile-and-views.md)
- [Org admin](org-admin.md)
- [Full catalog with input schemas](catalog.md)

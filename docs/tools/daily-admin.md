# Daily admin tools

Day-to-day Atlassian Cloud admin: JSM service-desk configuration,
Assets/Insight CMDB, Jira automation rules, custom fields, and the safe
project-management surface (create + archive; delete is in its own group
covered in [schemes-and-workflows.md](schemes-and-workflows.md)).

Roughly 69 tools across 10 permission groups. The auto-generated
[catalog](catalog.md) lists every tool with its full input schema.

## JSM admin (`read_jsm_admin` / `write_jsm_admin`)

**Credential:** API token side-channel (`gojira.bindApiToken` must be
called first per user).

### Service desks
- `jsm.listServiceDesks` — paginated.
- `jsm.getServiceDesk(serviceDeskId)`.

### Request types
- `jsm.listRequestTypes(serviceDeskId, groupId?)`.
- `jsm.getRequestType(serviceDeskId, requestTypeId)`.
- `jsm.createRequestType(serviceDeskId, issueTypeId, name, description?, helpText?)` — destructive, revertible.
- `jsm.deleteRequestType(serviceDeskId, requestTypeId)` — destructive, **irreversible**.
- `jsm.getRequestTypeFields(serviceDeskId, requestTypeId)`.
- `jsm.getRequestTypeGroups(serviceDeskId)`.

### Queues (read-only — the public API has no queue writes)
- `jsm.listQueues(serviceDeskId)`.
- `jsm.getQueue(serviceDeskId, queueId)`.
- `jsm.getQueueIssues(serviceDeskId, queueId, start?, limit?)`.

### SLA state, organizations & KB
- `jsm.getRequestSla(requestIdOrKey)` — per-request SLA *state* (SLA goal
  *configuration* has no public API; see the
  [capability map](../architecture/jsm-capability-map.md)).
- `jsm.listJsmOrganizations(serviceDeskId?)`.
- `jsm.addCustomersToOrganization(organizationId, accountIds?, usernames?, commit)` — destructive, revertible (removes the customers it added).
- `jsm.removeCustomersFromOrganization(organizationId, accountIds?, usernames?, commit)` — destructive, revertible (re-adds the customers it removed).
- `jsm.searchKnowledgeBaseArticles(serviceDeskId, query)`.

> Earlier versions also shipped queue/SLA/portal *write* tools — those called
> endpoints that don't exist in Atlassian Cloud and were removed. What remains
> is the live-verified surface; portal branding, SLA config, and the email
> channel are UI-only (capability map).

## Forms (`read_jsm_admin` / `write_jsm_admin`)

**Credential:** the same bound API token — the Forms API's Basic-auth host
(`api.atlassian.com/jira/forms/cloud/{cloudId}`) needs no OAuth scope.
Full template lifecycle verified live.

- `forms.listFormTemplates(projectIdOrKey)` — portal request forms / intake forms.
- `forms.getFormTemplate(projectIdOrKey, formId)` — includes the full `design` document (export/adapt).
- `forms.getRequestTypeForm(serviceDeskId, requestTypeId)`.
- `forms.listIssueForms(issueIdOrKey)` / `forms.getIssueFormAnswers(issueIdOrKey, formId)`.
- `forms.createFormTemplate(projectIdOrKey, form)` — destructive, revertible.
- `forms.updateFormTemplate(projectIdOrKey, formId, form)` — destructive, revertible; attach to portal
  request types via `portalRequestTypeIds`.
- `forms.deleteFormTemplate(projectIdOrKey, formId)` — destructive, **irreversible** (design captured in journal).

## Assets / Insight (`read_assets` / `write_assets`)

**Credential:** OAuth, with the CMDB granular scopes — *not* the API
token side-channel. Every `assets.*` tool is `authMethod: "oauth"`, and
the workspace-id discovery step that precedes each call is OAuth too, so
a bound API token alone is insufficient (discovery raises
`AUTH_REQUIRED`).

Assets is a **Premium** JSM feature. On a non-Premium site these tools
403 — that is a licensing limit, not a bug.

### Schemas
- `assets.listObjectSchemas`.
- `assets.getObjectSchema(schemaId)`.
- `assets.createObjectSchema(name, objectSchemaKey, description?, commit)` — destructive.
- `assets.updateObjectSchema(schemaId, name?, objectSchemaKey?, description?, commit)` — destructive, revertible.
- `assets.exportAssetSchema(schemaId)` — emits schema + types + attributes as one JSON. Useful as a backup before destructive ops.

### Object types
- `assets.listObjectTypes(schemaId)`.
- `assets.getObjectType(objectTypeId)`.
- `assets.createObjectType(schemaId, name, description?, iconId?, inherited?, parentObjectTypeId?, commit)` — destructive.
- `assets.updateObjectType(objectTypeId, name?, description?, iconId?, commit)` — destructive, revertible.

### Attributes
- `assets.getObjectTypeAttributes(objectTypeId)`.
- `assets.createObjectTypeAttribute(objectTypeId, attribute, commit)` — destructive.
- `assets.updateObjectTypeAttribute(objectTypeId, attributeId, attribute, commit)` — destructive, revertible. `objectTypeId` is required: it is part of the path, not just a lookup hint.

### Objects (data plane)
- `assets.aqlSearch(qlQuery, page?, resultPerPage?, includeAttributes?)`.
- `assets.getObject(objectId)`.
- `assets.createObject(objectTypeId, attributes[], hasAvatar?, commit)` — destructive.
- `assets.updateObject(objectId, attributes[], commit)` — destructive, revertible.
- `assets.deleteObject(objectId, commit)` — destructive, irreversible.

### References & metadata (read-only)
- `assets.getObjectReferences(objectId)`.
- `assets.getObjectAttachments(objectId)`.
- `assets.getObjectHistory(objectId)`.

References are **read-only**. There is no add/remove-reference tool
because there is no such endpoint: a reference is expressed as an
attribute value, so you create or drop one by writing the referencing
attribute through `assets.createObject` / `assets.updateObject`.

### Bulk import
- `assets.startImport(importId, commit)` — destructive, irreversible.

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

- `automation.listAutomationRules(cursor?, limit?)` — paginated rule summaries.
- `automation.getAutomationRule(ruleId)` — full rule by UUID.
- `automation.searchManualRules(payload)` — manually-triggerable rules for a given object (e.g. an issue).
- `automation.searchAutomationTemplates(payload?)` — search the rule-template catalog (pass `{}` for all).
- `automation.getAutomationTemplate(templateId)`.
- `automation.createAutomationRule(rule, commit?)` — destructive, revertible (disable, then delete by UUID).
- `automation.createRuleFromTemplate(templateId, ruleHome, parameters?, commit?)` — destructive, revertible (disable, then delete by UUID). `ruleHome` is the scope ARI, e.g. `ari:cloud:jira:{cloudId}:project/{projectId}`.
- `automation.updateAutomationRule(ruleId, rule, commit?)` — destructive, revertible (full-before/full-after).
- `automation.deleteAutomationRule(ruleId, commit?)` — destructive, **irreversible**. Disables the rule first (the API rejects deleting an enabled rule) and re-enables it if the delete fails.
- `automation.enableAutomationRule(ruleId, commit?)` — destructive, revertible (restores the captured prior state).
- `automation.disableAutomationRule(ruleId, commit?)` — destructive, revertible (restores the captured prior state).

## Custom fields (`read_customfields` / `write_customfields`)

**Credential:** OAuth.

- `customfields.listCustomFields(startAt?, maxResults?, query?, type[]?, id[]?)`.
- `customfields.getCustomField(fieldId, include_contexts?)`.
- `customfields.createCustomField(name, description?, type, searcherKey?, commit)` — destructive, revertible.
- `customfields.updateCustomField(fieldId, name?, description?, searcherKey?, commit)` — destructive, revertible.
- `customfields.deleteCustomField(fieldId, commit)` — destructive, **irreversible** (may detach values from issues).
- `customfields.listCustomFieldContexts(fieldId, startAt?, maxResults?)`.
- `customfields.assignCustomFieldToProjects(fieldId, contextId, projectIds[], commit)` — destructive, revertible.
- `customfields.setCustomFieldOptions(fieldId, contextId, options[], commit)` — destructive, **not revertible**.

`setCustomFieldOptions` is an upsert, not a replace: Jira splits the two
verbs, so options *with* an `id` are PUT (update in place) and options
*without* one are POST (create). Nothing is ever deleted. That is
exactly why it journals `revertible: false` — re-applying the captured
`before` would restore the edited options but could not remove the ones
the call created. The `before` snapshot is still captured for a manual
cleanup.

## Projects (`read_projects` / `write_projects`)

**Credential:** OAuth. Project deletion lives in its own permission
group (see [schemes-and-workflows.md](schemes-and-workflows.md#delete-projects)).

- `projects.listJiraProjects(startAt?, maxResults?, expand[]?, query?, typeKey?, orderBy?)` — admin view.
- `projects.getJiraProject(project, expand[]?)`.
- `projects.getJiraProjectDetails(project)` — includes components + roles + permissions.
- `projects.createJiraProject(key, name, projectTypeKey, projectTemplateKey?, leadAccountId, description?, assigneeType?, url?)` — destructive, not auto-revertible.
- `projects.archiveJiraProject(project)` — destructive, revertible (restore).

## See also

- [Schemes and workflows](schemes-and-workflows.md) — including isolated `delete_projects`
- [Agile and views](agile-and-views.md)
- [Org admin](org-admin.md)
- [Full catalog with input schemas](catalog.md)

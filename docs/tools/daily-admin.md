# Daily admin tools

Day-to-day Atlassian Cloud admin: JSM service-desk configuration,
Assets/Insight CMDB, Jira automation rules, custom fields, and the safe
project-management surface (create + archive; delete is in its own group
covered in [schemes-and-workflows.md](schemes-and-workflows.md)).

Roughly 60 tools across 10 permission groups. The auto-generated
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
- `jsm.addCustomersToOrganization(organizationId, accountIds)` — destructive.
- `jsm.removeCustomersFromOrganization(organizationId, accountIds)` — destructive.
- `jsm.searchKnowledgeBaseArticles(serviceDeskId, query)`.

> Earlier versions also shipped queue/SLA/portal/forms *write* tools — those
> called endpoints that don't exist in Atlassian Cloud and were removed. What
> remains is the live-verified surface; portal branding, SLA config, and the
> email channel are UI-only (capability map).

## Assets / Insight (`read_assets` / `write_assets`)

**Credential:** API token side-channel for the data plane; OAuth
required for the workspace-id discovery step (handled automatically).

### Schemas
- `assets.listObjectSchemas`.
- `assets.getObjectSchema(schemaId)`.
- `assets.createObjectSchema(name, objectSchemaKey, description?)` — destructive.
- `assets.updateObjectSchema(schemaId, name?, objectSchemaKey?, description?)` — destructive, revertible.
- `assets.exportAssetSchema(schemaId)` — emits schema + types + attributes as one JSON. Useful as a backup before destructive ops.

### Object types
- `assets.listObjectTypes(schemaId)`.
- `assets.getObjectType(objectTypeId)`.
- `assets.createObjectType(schemaId, name, description?, iconId?, inherited?, parentObjectTypeId?)` — destructive.
- `assets.updateObjectType(objectTypeId, name?, description?, iconId?)` — destructive, revertible.

### Attributes
- `assets.getObjectTypeAttributes(objectTypeId)`.
- `assets.createObjectTypeAttribute(objectTypeId, attribute)` — destructive.
- `assets.updateObjectTypeAttribute(attributeId, attribute)` — destructive, revertible.

### Objects (data plane)
- `assets.aqlSearch(qlQuery, page?, resultPerPage?, includeAttributes?)`.
- `assets.getObject(objectId)`.
- `assets.createObject(objectTypeId, attributes[], hasAvatar?)` — destructive.
- `assets.updateObject(objectId, attributes[])` — destructive, revertible.
- `assets.deleteObject(objectId)` — destructive, irreversible.

### References & metadata
- `assets.getObjectReferences(objectId)`.
- `assets.addObjectReference(objectId, targetObjectId, referenceTypeId)` — destructive, revertible.
- `assets.removeObjectReference(objectId, targetObjectId, referenceTypeId)` — destructive, revertible.
- `assets.getObjectAttachments(objectId)`.
- `assets.getObjectHistory(objectId)`.

### Bulk
- `assets.importAssetsFromCsv(importConfigurationId, csvUrl? | csvInline?)` — destructive, irreversible.

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
- `customfields.createCustomField(name, description?, type, searcherKey?)` — destructive, revertible.
- `customfields.updateCustomField(fieldId, name?, description?, searcherKey?)` — destructive, revertible.
- `customfields.deleteCustomField(fieldId)` — destructive, **irreversible** (may detach values from issues).
- `customfields.listCustomFieldContexts(fieldId, startAt?, maxResults?)`.
- `customfields.assignCustomFieldToProjects(fieldId, contextId, projectIds[])` — destructive, revertible.
- `customfields.setCustomFieldOptions(fieldId, contextId, options[])` — destructive, revertible.

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

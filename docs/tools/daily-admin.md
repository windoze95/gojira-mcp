# Daily admin tools

Day-to-day Atlassian Cloud admin: JSM service-desk configuration,
Assets/Insight CMDB, Jira automation rules, custom fields, and the safe
project-management surface (create + archive; delete is in its own group
covered in [schemes-and-workflows.md](schemes-and-workflows.md)).

Roughly 95 tools across 10 permission groups. The auto-generated
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
- `jsm.updateRequestType(serviceDeskId, requestTypeId, name?, description?, helpText?)` — destructive, revertible.
- `jsm.deleteRequestType(serviceDeskId, requestTypeId)` — destructive, **irreversible**.
- `jsm.getRequestTypeFields(serviceDeskId, requestTypeId)`.
- `jsm.setRequestTypeFields(serviceDeskId, requestTypeId, fields[])` — destructive, revertible.
- `jsm.getRequestTypeGroups(serviceDeskId)`.
- `jsm.assignRequestTypeToGroup(serviceDeskId, requestTypeId, groupId)` — destructive.

### Queues
- `jsm.listQueues(serviceDeskId)`.
- `jsm.getQueue(serviceDeskId, queueId)`.
- `jsm.createQueue(serviceDeskId, name, jql, fields?)` — destructive, revertible.
- `jsm.updateQueue(serviceDeskId, queueId, name?, jql?, fields?)` — destructive, revertible.
- `jsm.deleteQueue(serviceDeskId, queueId)` — destructive, irreversible.
- `jsm.getQueueIssues(serviceDeskId, queueId, start?, limit?)`.

### SLAs
- `jsm.listSlas(projectKey)`.
- `jsm.getSla(projectKey, slaId)`.
- `jsm.createSla(projectKey, sla)` — destructive.
- `jsm.updateSla(projectKey, slaId, sla)` — destructive, revertible.
- `jsm.getSlaMetrics(projectKey, since?, until?, metricIds?)`.

### Organizations & portals
- `jsm.listJsmOrganizations(serviceDeskId?)`.
- `jsm.addCustomersToOrganization(organizationId, usernames?, accountIds?)` — destructive.
- `jsm.listPortals` — alias for the service-desk listing.
- `jsm.getPortalCustomization(serviceDeskId)`.
- `jsm.updatePortalCustomization(serviceDeskId, announcement?)` — destructive, revertible.

### Forms & KB
- `jsm.listForms(serviceDeskId)`.
- `jsm.getForm(serviceDeskId, formId)`.
- `jsm.createForm(serviceDeskId, form)` — destructive.
- `jsm.updateForm(serviceDeskId, formId, form)` — destructive, revertible.
- `jsm.getServiceDeskKnowledgeBase(serviceDeskId)`.
- `jsm.linkKbToServiceDesk(serviceDeskId, spaceKey)` — destructive.

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

**Credential:** OAuth.

- `automation.listAutomationRules(projectKey?, query?, startAt?, maxResults?)`.
- `automation.getAutomationRule(ruleId)`.
- `automation.createAutomationRule(projectKey?, rule)` — destructive, revertible.
- `automation.updateAutomationRule(ruleId, rule)` — destructive, revertible (full-before/full-after).
- `automation.deleteAutomationRule(ruleId)` — destructive, irreversible.
- `automation.enableAutomationRule(ruleId)` — destructive, revertible (disable).
- `automation.disableAutomationRule(ruleId)` — destructive, revertible (enable).
- `automation.getAutomationRuleAuditLog(ruleId, startAt?, maxResults?)`.
- `automation.getAutomationUsage` — site-wide automation usage stats.

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

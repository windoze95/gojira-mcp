# Adding an operation

The surface is **61 tools carrying 155 operations**. Most tools are
op-parameterized: one MCP tool holding 2–7 operations selected by a
required `op` field, built by the `defineOpTool` factory in
`src/tools/defs/defineOpTool.ts`.

So the usual unit of new work is an **op on an existing tool**, not a new
tool. This page covers that first, then the cases where a new tool — or a
plain single-op `defineTool` — is the right answer.

The running example adds a read op `getRuleHistory` to
`automation.readRule`.

## 1. Decide where it goes

In order, take the first that applies:

1. **An existing tool already owns this sub-domain, has room (fewer than
   7 ops), and shares most of the input shape** → add an op to it.
2. **It deletes something** → it belongs in that prefix's `.delete`
   tool, never as a third op on `.manage`. Delete ops carry a different
   dry run (`deleteDryRun`, no after-state) and a different reversibility
   story; keeping them together means one tool an operator can disable or
   audit as a unit.
3. **No tool owns the sub-domain, or the natural home is full, or the
   input shape doesn't fit** → a new op tool, named on the
   `read` / `manage` / `delete` pattern (`schemes.readAccess`,
   `filters.manage`, `assets.delete`).
4. **It is genuinely alone** — no sibling, no read/write partner, and no
   op tool it fits — → a plain `defineTool` (see
   [§7](#7-single-op-tools)).

Three constraints shape that decision:

**The 5–7 op cap.** The factory throws below 2 and above 7. Treat 5 as
the point where you start looking for a split — the cap is a model
attention budget, not a technical limit, and a tool whose `op` enum
description runs to a screen is one a model picks from badly. Split along
sub-domain lines, never alphabetically: `schemes.read*` became
`readAccess` (permission + notification schemes), `readScreen` (screens +
screen schemes) and `readConfig` (workflow / issue-type schemes, field
configurations), each of which reads as one topic.

**Ops merge only on compatible input shapes.** The advertised schema is
the *union* of every op's fields, so bolting on an op that shares nothing
with its neighbours makes the whole tool a grab-bag of unrelated optional
fields — a strictly worse advertisement than two focused tools. This is
why `confluence.setContentRestrictions` stayed on its own: its
`contentId` + `restrictions[]` shape has nothing in common with
`spaceKey` / `name` / `description`.

**Destructive homogeneity.** A tool is all-destructive or all-read; the
factory rejects a mix, because the confirm-op card is attached per tool
and would mislabel read results. A read operation that conceptually
belongs with the writes goes in the read tool or stays its own keeper —
`workflows.validateCreateWorkflow` is the worked example.

## 2. Check the permission group

An op inherits its tool's group, auth method and cloudId requirement, so
adding one to the right tool is usually the whole story. `readRule` is
`read_automation` / `api_token` / `needsCloudId: true` — the automation
public API has no OAuth scope, so these tools authenticate with the bound
per-user API token (Basic auth), and the token's account must be a Jira
administrator. See
[API token side-channel](../oauth/api-token-side-channel.md).

If the work needs a group that doesn't exist:

- Add the group name to `ALL_PERMISSION_GROUPS` in
  `src/tools/permissionGroups.ts` (the `PermissionGroup` type derives
  from that array).
- Document it in [docs/tools/permission-groups.md](../tools/permission-groups.md).
- Update every deployment's `GOJIRA_ENABLED_GROUPS` — allowlist
  semantics, new groups never auto-enable.

## 3. Write the op spec

Add a `defineOp({...})` to the tool's `ops: []`:

```ts
defineOp({
  op: "getRuleHistory",
  description: "Get the run history for a single automation rule.",
  input: {
    ruleId,                       // hoisted const, shared with getAutomationRule
    since: z.string().datetime().optional().describe("ISO lower bound"),
    limit: z.number().int().positive().max(100).default(25).optional(),
  },
  handler: async (input, ctx) => {
    const p = new URLSearchParams({ limit: String(input.limit ?? 25) });
    if (input.since) p.set("since", input.since);
    const resp = await ctx.client
      .automation()
      .get<unknown>(`${BASE}/rule/${encodeURIComponent(input.ruleId)}/history?${p.toString()}`);
    return resp.data;
  },
}),
```

Field by field:

**`op`** — the name mirrors what a leaf verb would have been if this were
its own tool: `getRuleHistory`, not `history` or `get`. That name is what
a model reads in the `op` enum, what a journal entry records in
`request.op`, and what the reverter key is built from.

**`description`** — **one compact line.** The factory concatenates every
op's description into the `op` field's description, so a paragraph here
is a paragraph in every ListTools payload for every caller. Long-form
operational contracts belong here only when the caller genuinely cannot
use the op without them, and then as one long line —
`workflows.manage`'s `publishWorkflowSchemeDraft` is the precedent, and
it earns it.

**`input`** — a raw zod shape with **real required-ness**. This is the
one place the truth is written: the advertised merged schema marks a
field required only when *every* op has it and requires it, so almost
everything shows up optional there. The strict per-op schema built from
this shape is what actually validates at dispatch, and it is `.strict()`,
so a sibling op's field is rejected with a message naming the op that
owns it.

**`handler(input, ctx, meta)`** — `input` is the parsed per-op type,
fully inferred. `meta` carries `{ tool, op, dryRun, deleteDryRun }`.

### Field rules the factory enforces at load

These throw when the module is imported, so a violation fails the whole
test run, not one case:

- **One hoisted const per shared field name.** Ops that both take
  `ruleId` must reference the *same* `const ruleId = z.string()...`.
  Required-ness wrappers may differ — the factory unwraps
  optional/nullable/default before comparing identity, so
  `{ boardId }` in one op and `{ boardId: boardId.optional() }` in
  another is fine. Two separately-constructed schemas under one name
  throw *"declared with different schema instances … hoist one shared
  const"*.
- **Distinct field names must not share an instance.** `zod-to-json-schema`
  dedups a repeated instance into a `$ref`, and the advertised schema has
  to stay flat. Reusing one `z.string()` for both `spaceKey` and
  `contentId` throws *"share one zod instance"*; build a fresh instance
  per field.
- **`op` and `commit` are reserved.** Never declare either in an op's
  input. `op` is the selector; `commit` is added automatically to
  destructive tools.
- **`.default()` does not reliably fire.** The merged advertisement
  strips the default and wraps the field in an outer `.optional()`, which
  short-circuits on `undefined` before any default can apply. Declare the
  default if you want it in the catalog, but resolve it in the handler —
  `input.limit ?? 25` — the way every converted module does.

When a field name genuinely means different things in different ops
(`schemes.readAccess`'s `schemeId` is a permission scheme id for two ops
and a notification scheme id for the other two), say so in the shared
const's `.describe()`. It is the only place a caller will see it.

## 4. Destructive ops

Set `destructive: true` on the op — and on every other op in the tool, or
the factory rejects the mix. The tool then gets a `commit` field for
free; do not declare it and do not journal it (the factory strips it out
of `request`).

Dry runs come from `meta`, pre-filled with the live tool name — which is
what the confirm card re-invokes, so never hand-write the tool string:

```ts
const dry = meta.dryRun({
  target: { kind: "automation_rule", id: input.ruleId },
  before: before.data,
  after,
});
if (dry) return dry;          // null once commit:true was passed
```

For delete-class ops use `meta.deleteDryRun` instead — it is the right
shape (before-snapshot, no after, irreversibility warning) and it does
*not* check `commit` for you:

```ts
if (input.commit !== true) {
  return meta.deleteDryRun({ target: {...}, before: before.data });
}
```

## 5. Journal conventions

```ts
const entry = await ctx.journalOp({
  ...ctx.defaultJournalArgs,      // { accountId, tool, cloudId }
  target: { kind: "automation_rule", id: input.ruleId },
  before: before.data,
  request: body,
  revertible: true,
  revertHint: "PUT the captured `before` payload back.",
  run: async () => { /* the mutation */ },
});
return { ok: true, journal_id: entry.opId };
```

- **Spread `ctx.defaultJournalArgs`.** It carries `accountId`, `tool` and
  `cloudId`; hand-writing `tool:` is how the name drifts.
- **`request.op` is injected automatically.** Don't add it. The factory
  wraps `ctx.journalOp` per dispatch to prepend it, and that is what
  `canonicalReverterKey` reads to resolve `tool#op`.
- **For revertible ops, journaled field names are a contract.** Reverters
  probe `k in entry.request` to decide which fields to restore, so
  journal the *patch* — the fields the caller actually touched — not the
  whole input, and don't rename one without updating its reverter.
  `agile.manageSprint#updateSprint` and `filters.manage#updateFilter`
  both depend on this.
- **Creates need `deriveTargetId`.** Reverters read `entry.target.id`,
  and it has to be persisted before the entry completes; mutating the
  returned entry afterwards does not persist.
- **`revertible:` is per-invocation truth; `claimsRevertible` is the
  static promise.** The op spec's `claimsRevertible` defaults to
  `!!revert`. Set it explicitly when revertibility is conditional
  (`projects.delete` is revertible only in trash mode) so the coverage
  test knows what to check.

## 6. Reverters and legacy names

A reverter goes **on the op spec**, not at the bottom of the file:

```ts
revert: async (entry, anyCtx) => {
  const ctx = anyCtx as ToolContext;
  const id = (entry.target as { id?: string }).id;
  if (!id) throw new Error("Cannot revert: rule id missing from target.");
  await ctx.client.automation().put<unknown>(`/rule/${encodeURIComponent(id)}`, entry.before);
  return { restored: id };
},
```

It registers under `` `${tool}#${op}` ``. The reverter itself runs
through the normal tool path (auth, rate limit, audit) and is journaled.

Three rules around registration:

- **`defineOpTool` must be called at module level** — a `const` beside
  the module's exported `tools()` function. Registration is a side
  effect, and the registry rejects a second registration of a *different*
  function under the same key, which is exactly what a per-call
  invocation produces. `tests/server/multiInstance.test.ts` builds two
  sessions and trips this immediately.
- **Single-op keepers register at the file bottom under the bare tool
  name.** That set is exactly `automation.createRuleFromTemplate`,
  `confluence.setContentRestrictions` and `projects.delete`, and the
  coverage test asserts the list verbatim — a new bare key means editing
  that test deliberately.
- **`admin_org` registers no reverters at all.** The factory throws if an
  `admin_org` op declares one.

**`legacyName`** is only for an op that absorbs a tool which existed
before the collapse. It registers an alias so journal entries written
under the old name (30-day TTL) still resolve to `tool#op`. Never invent
one for a genuinely new op: an alias pointing at a name that never
shipped is dead weight, and the coverage test asserts no alias shadows a
live tool name.

## 7. Single-op tools

When an operation is genuinely alone, use `defineTool` directly:

```ts
defineTool({
  name: "workflows.validateCreateWorkflow",
  description: "Dry-run validation for a create-workflow payload (no changes).",
  group: "write_workflows",
  authMethod: "oauth",
  needsCloudId: true,
  readOnly: true,
  input: { payload: z.record(z.string(), z.unknown()) },
  handler: async (input, ctx) => { /* ... */ },
});
```

Two things differ from an op tool:

**Annotations are purely flag-driven.** The leaf-verb regex that used to
infer read-only-ness from a `list*` / `get*` name is **gone** — every one
of the 61 tools carries an explicit truth. `destructive: true` yields
`readOnlyHint: false` + `destructiveHint: true`; an explicit
`readOnly: true` yields `readOnlyHint: true`; neither yields *no
annotations at all*, so hosts confirm by default. A read tool that
forgets `readOnly: true` silently loses its annotation — nothing fails,
it just stops telling the host it is safe.

**`commit` is yours to declare.** Only op tools get it automatically:

```ts
input: { filterId: z.string().min(1), commit: z.boolean().optional() },
```

Single-op tools also hand-write the tool name into `buildDeleteDryRun({
tool: "filters.delete", ... })` and `reverters.register("projects.delete",
...)`. Those strings and `defineTool({ name })` must match exactly; the
compiler does not check it.

A 1:1 rename uses `defineTool`'s own `legacyName` (registered with
`op: null`), which is how `filters.deleteFilter` → `filters.delete`
stayed revertible.

## 8. Naming and descriptions

- Op tools: `<prefix>.read*` / `<prefix>.manage*` / `<prefix>.delete`.
  Keepers: `<prefix>.<verb>`. Don't abbreviate prefixes (`auto.` ≠
  `automation.`), don't exceed 128 characters (the MCP SDK enforces it).
- **The tool description must enumerate its ops.** A name like
  `schemes.managePermission` carries no information by itself; the
  description is the selection index for models and for tool search.
  Every converted tool names each op in parentheses — *"Manage permission
  schemes: create one (createPermissionScheme), update one — PUT-replace
  semantics (updatePermissionScheme), or assign one to a project
  (assignPermissionSchemeToProject). All revertible."*

## 9. The two drift gates

Both run in CI; neither is optional.

**`tests/tools/opRevertCoverage.test.ts`** reads the machine manifest
that `defineOpTool` attaches to every tool, and asserts: every op
claiming revertibility has a registered `tool#op` reverter; no reverter
key points at a tool or op that no longer exists; the bare-name keys are
exactly the three single-op keepers; `admin_org` is spotless; every
legacy alias resolves to a live tool (and live op); no alias shadows a
live tool name; and every op tool is homogeneous, within 2–7 ops, and
annotates honestly.

**`npm run docs:tools`** regenerates `docs/tools/catalog.md` from the
live registry — per-op input tables, `Replaces:` lines from `legacyName`,
and the pre-collapse → current name map. CI runs
`git diff --exit-code docs/tools/catalog.md` and fails on a stale
catalog, so regenerate and commit it in the same change.

`tests/tools/defineOpTool.test.ts` covers the factory contract itself
(advertised shape, strict dispatch, `request.op` injection, dry-run
name pre-fill, the side-effect registrations). Add to it when you change
the factory, not when you add an op.

## 10. Test and verify

Simple read ops that delegate to a single GET don't need a dedicated
test — the upstream behaviour is what matters. Add one under
`tests/tools/` for ops that compose multiple upstream calls, mutate input
materially, carry tricky revert semantics, or do non-trivial validation.
See [testing.md](testing.md); use `tests/helpers/redis.ts` if you need
Redis.

```bash
npm run typecheck
npm test
npm run docs:tools && git diff --exit-code docs/tools/catalog.md
```

## 11. Document, when it needs context

Most operations explain themselves in the catalog. Add narrative to the
group-family doc (`docs/tools/<family>.md`) when the op has:

- unusual side effects — `publishWorkflowSchemeDraft`'s async poll and
  its "RUNNING means not done" contract;
- a deployment or safety knob — `projects.delete`'s `permanent`;
- a live-verified API quirk that would otherwise read as a bug —
  Confluence Free 403ing restriction writes, the v1 space GET being 410;
- a field-vocabulary trap — one shared field name addressing two id
  spaces.

## Common pitfalls

- **`defineOpTool` called inside `tools()`** instead of at module level →
  *"already registered … different function"* the moment a second session
  is built.
- **Over-optionalizing.** The merged advertisement already optionalizes;
  adding `.optional()` to an op input the handler genuinely needs means
  the dispatch parse happily accepts a call without it.
- **Two `z.string()`s for one field name**, or one instance for two field
  names — both throw at load, with the fix in the message.
- **Journaling the whole input** instead of the patch, on a revertible
  op → the `k in entry.request` reverter restores fields the op never
  touched.
- **Forgetting `readOnly: true`** on a read keeper: no error, just a tool
  that stops advertising itself as safe.
- **Wrong `authMethod`.** API-token tools won't dispatch without a bound
  token; OAuth tools won't dispatch without a fresh upstream credential.
  Pick what the underlying Atlassian API requires, not what is
  convenient.
- **Skipping `needsCloudId: true`.** Anything hitting
  `api.atlassian.com/ex/jira/<cloudId>/...` needs it, as do the
  automation and forms tools (their base URLs embed the cloudId too).
  Without it `ctx.cloudId` is `null` and the client factory throws.

## See also

- [Tools overview](../tools/overview.md)
- [Permission groups](../tools/permission-groups.md)
- [Operation journal](../architecture/operation-journal.md)
- [Commit-positive consent](../architecture/commit-positive-consent.md)
- [Testing](testing.md)
- [Full catalog with input schemas](../tools/catalog.md)

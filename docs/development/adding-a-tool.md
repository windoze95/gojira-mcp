# Adding a tool

End-to-end recipe for adding a tool to the surface. The example below
adds a hypothetical read tool `automation.getRuleHistory`.

## 1. Pick the permission group

If the new tool fits an existing group (`read_automation` for read-only
automation surface in this case), good — no new group needed. If it
needs a new group:

- Add the group name to `ALL_PERMISSION_GROUPS` in
  `src/tools/permissionGroups.ts` (the `PermissionGroup` type is
  derived from this array).
- Document it in [docs/tools/permission-groups.md](../tools/permission-groups.md).
- Update every deployment's `GOJIRA_ENABLED_GROUPS` if you want the new
  group registered (allowlist semantics — new groups never auto-enable).

For our example we reuse `read_automation` — OAuth.

## 2. Pick the name

Use the group's prefix, dot-separated:

```
automation.getRuleHistory
```

Don't:

- abbreviate prefixes (`auto.` ≠ `automation.`)
- use mixed casing on the prefix (`Automation.` is rejected by no rule
  but breaks visual clustering)
- exceed 128 characters total (MCP SDK enforces this)

## 3. Define the tool

In the appropriate `src/tools/defs/<group>.ts`:

```ts
defineTool({
  name: "automation.getRuleHistory",
  description: "Get the run history for a single automation rule.",
  group: "read_automation",
  authMethod: "oauth",
  destructive: false,
  needsCloudId: true,
  input: {
    ruleId: z.string().min(1),
    since: z.string().datetime().optional(),
    limit: z.number().int().positive().max(100).default(25).optional(),
  },
  handler: async (input, ctx) => {
    const p = new URLSearchParams({ limit: String(input.limit ?? 25) });
    if (input.since) p.set("since", input.since);
    const resp = await ctx.client.jira().get<unknown>(
      `${BASE}/rules/${encodeURIComponent(input.ruleId)}/history?${p.toString()}`,
    );
    return resp.data;
  },
}),
```

The `defineTool` helper is in `src/tools/defs/defineTool.ts`. Its types
infer the handler's `input` from the `input` schema you supply.

## 4. For destructive tools, add commit-positive consent

Read tools (the example above) need none. Destructive tools must:

```ts
handler: async (input, ctx) => {
  // Snapshot for diff and journal
  const before = await ctx.client.jira().get<unknown>(`/rest/.../${id}`);
  const body = { ... };
  const after = { ...(before.data as object), ...body };

  // Dry-run
  const dry = buildDryRunIfNotCommitted(input, {
    tool: "automation.updateAutomationRule",
    target: { kind: "automation_rule", id: input.ruleId },
    before: before.data,
    after,
  });
  if (dry) return dry;

  // Journal-wrapped mutation
  const entry = await ctx.journalOp({
    accountId: ctx.accountId,
    tool: "automation.updateAutomationRule",
    cloudId: ctx.cloudId,
    target: { kind: "automation_rule", id: input.ruleId },
    before: before.data,
    request: body as Record<string, unknown>,
    revertible: true,
    revertHint: "PUT the captured `before` payload back.",
    run: async () => {
      const resp = await ctx.client.jira().put<unknown>(`/rest/.../${id}`, body);
      return resp.data;
    },
  });
  return { ok: true, journal_id: entry.opId };
},
```

Set `destructive: true` in the tool definition. The wrapper will
enforce dry-run-first regardless of the handler's body.

For deletes, use `buildDeleteDryRun` instead of
`buildDryRunIfNotCommitted` — it's the right shape (`before` snapshot,
`after: null`, no patch) and the dry-run message warns about
irreversibility.

## 5. For revertible operations, register a reverter

At the bottom of the same `defs/` file:

```ts
reverters.register("automation.updateAutomationRule", async (entry, anyCtx) => {
  const ctx = anyCtx as import("../types.js").ToolContext;
  const before = entry.before;  // captured at journal-write time
  const id = (entry.target as { id?: string }).id;
  if (!id || before == null) {
    throw new Error("Cannot revert: required entry fields missing");
  }
  await ctx.client.jira().put<unknown>(`/rest/.../${id}`, before);
  return { restored: id };
});
```

The reverter runs through the normal tool path (auth + rate limit +
audit) and is itself journaled. The `entry.before` field holds whatever
you passed at journal-write time.

For non-revertible destructive ops, skip the `reverters.register` call;
just set `revertible: false` on the journal entry. The
`assertRevertible` check refuses revert attempts gracefully.

## 6. Run the catalog generator

```bash
npm run docs:tools
```

This regenerates `docs/tools/catalog.md` with the new tool's full input
schema. Commit the diff.

## 7. Add a test (when the path is non-trivial)

For simple read tools that delegate to a single GET, the upstream
behaviour is what matters and we don't unit-test the wrapper for each
one. For:

- Tools that compose multiple upstream calls
- Tools that mutate input materially
- Tools with revertible-but-tricky semantics
- Tools with non-trivial validation

…add a test under `tests/tools/`. Use the existing `tests/helpers/redis.ts`
helper if you need Redis. See [testing.md](testing.md).

## 8. Verify

```bash
npm run typecheck
npm test
npm run docs:tools && git diff --exit-code docs/tools/catalog.md
```

If the catalog regen shows changes, you forgot to commit it.

## 9. Document (when the tool needs context)

Most tools are self-explanatory in the catalog. Add narrative to the
group-family doc (`docs/tools/<family>.md`) only when:

- The tool has unusual side effects (e.g.,
  `workflows.publishWorkflow`'s async behaviour deserved a paragraph)
- The tool interacts with a deployment knob (`projects.deleteJiraProject`'s
  `enableUndo` semantics)
- The tool is the centerpiece of a workflow worth illustrating

## Common pitfalls

- **Forgot the prefix.** A tool named `getRuleHistory` instead of
  `automation.getRuleHistory` still registers, but breaks the
  visual-grouping convention. The catalog generator will surface it,
  but reviewers should catch.
- **Mismatched `tool: "..."` strings.** Every place that uses the tool
  name as a string — `defineTool({ name: ... })`, `journalOp({ tool: ... })`,
  `buildDryRunIfNotCommitted({ tool: ... })`, `reverters.register(...)`
  — must use the exact same string. The compiler doesn't catch
  divergence.
- **Wrong `authMethod`.** API-token tools won't dispatch without a
  bound token; OAuth tools won't dispatch without a fresh upstream
  credential. Pick what the underlying Atlassian API requires.
- **Skipping `needsCloudId: true`.** Tools that hit
  `api.atlassian.com/ex/jira/<cloudId>/...` need it. Without it,
  `ctx.cloudId` will be `null` and `ctx.client.jira()` throws.

## See also

- [Tools overview](../tools/overview.md)
- [Permission groups](../tools/permission-groups.md)
- [Operation journal](../architecture/operation-journal.md)
- [Commit-positive consent](../architecture/commit-positive-consent.md)
- [Testing](testing.md)

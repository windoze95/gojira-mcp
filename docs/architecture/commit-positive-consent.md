# Commit-positive consent

Every destructive write requires the input to carry `commit: true`. Absent
`commit`, the tool returns a **dry-run** payload describing exactly what
would happen — never executes the mutation.

The naming is deliberate: `commit: true` is *positive* consent. A forgotten
flag fails closed.

## Why positive consent

Negative consent (`dryRun: false`) is dangerous in tool-use scenarios
because:

- The model may forget to set it.
- A typo or schema drift defaults to "execute".
- "Don't" flags accumulate cognitive load.

Positive consent inverts the burden — the caller must opt in to mutation
on every invocation. The dry-run path is the default and the safe one.

## Dry-run shape

`buildDryRunIfNotCommitted(input, args)` from
`src/consent/dryRun.ts` returns:

```ts
interface DryRunResult {
  dry_run: true;
  tool: string;
  message: string;
  target: { kind: string; id?: string; key?: string; name?: string; ... };
  diff: {
    patch?: JsonPatchOp[];   // RFC 6902 — preferred
    before?: unknown;        // full snapshot fallback
    after?: unknown;
  };
  commit_hint: string;       // "Re-invoke with commit:true to apply"
}
```

`buildDeleteDryRun` is the delete-flavoured variant — emits
`{ diff: { before, after: null }}` without a patch (delete diffs are
trivially "the object goes away").

## JSON Patch generation

`src/consent/jsonPatch.ts` implements a small subset of RFC 6902:

- `add` / `remove` / `replace` ops
- Object diff walks all keys union of both sides
- Array values are replaced as a whole (array-level patches need identity
  keys and are ambiguous without)
- Primitive type mismatches emit `replace`
- JSON Pointer escaping: `/` → `~1`, `~` → `~0`

The generator is intentionally simple — large nested objects produce
many small ops, but reviewers can read each one cleanly. The trade-off:
move/copy semantics aren't supported. Workflows and schemes with deep
nesting may be better served by the `includeFullState: true` mode which
emits `before` + `after` blobs alongside the patch.

## Usage pattern

A typical destructive tool body:

```ts
handler: async (input, ctx) => {
  // 1. Snapshot for diff and journal
  const before = await ctx.client.jira().get<unknown>(`/rest/api/3/field/${fieldId}`);

  // 2. Compute the proposed after-state
  const body = { ... };
  const after = { ...(before.data as object), ...body };

  // 3. Commit-positive consent
  const dry = buildDryRunIfNotCommitted(input, {
    tool: "customfields.updateCustomField",
    target: { kind: "custom_field", id: fieldId },
    before: before.data,
    after,
  });
  if (dry) return dry;  // returns to caller; mutation does NOT run

  // 4. Journal-wrapped mutation
  const entry = await ctx.journalOp({
    accountId: ctx.accountId,
    tool: "customfields.updateCustomField",
    cloudId: ctx.cloudId,
    target: { kind: "custom_field", id: fieldId },
    before: before.data,
    request: body,
    revertible: true,
    revertHint: "PUT the captured `before` payload back.",
    run: async () => (await ctx.client.jira().put(`...`, body)).data,
  });
  return { ok: true, journal_id: entry.opId };
}
```

## Which tools are destructive

Marked `destructive: true` in the `defineTool` definition. The auto-generated
catalog at [docs/tools/catalog.md](../tools/catalog.md) lists them
explicitly with a `Destructive: yes` line.

Roughly: anything named `create*`, `update*`, `delete*`, `assign*`, `enable*`,
`disable*`, `set*`, `add*`, `remove*`, `archive*`, `publish*`, `link*`,
`provision*`, `deactivate*`, `restore*`, `verify*`, or `import*` is marked
destructive. Read tools (`list*`, `get*`, `aqlSearch`, `*Metrics`, `*AuditLog`)
are not.

## Bypass

There is no bypass. The wrapper enforces dry-run-first on every destructive
tool. To skip the dry-run round-trip, pass `commit: true` on the first
invocation — that's the expected pattern for automated flows.

## Audit + outcome

When a dry-run is returned, the audit record carries
`outcome: "dry_run"` and the response is *not* journaled (nothing
happened). When `commit: true` flows through, success audits with
`outcome: "success"` and the journal entry is written with the
before/after snapshots.

## See also

- [`gojira.revertOperation`](../tools/utility.md) uses the same dry-run
  pattern: re-invoke with `commit: true` to actually revert.
- [Operation journal](operation-journal.md) — captures before/after for
  every committed mutation.
- [Error model](error-model.md) — `VALIDATION_ERROR` is what callers see
  when they violate the schema; dry-run is not an error.

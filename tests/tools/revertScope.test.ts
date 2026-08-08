import { describe, expect, it, vi } from "vitest";
import { allTools } from "../../src/tools/defs/index.js";
import { reverters } from "../../src/operations/revert.js";
import { registerLegacyAlias } from "../../src/operations/legacyAliases.js";
import type { ToolContext } from "../../src/tools/types.js";
import type { JournalEntry } from "../../src/operations/journal.js";

/**
 * The inverse of revertCoverage.test.ts: reverters must be UNREACHABLE when
 * the original tool's group is not enabled on the calling instance. Split-
 * surface profiles share one journal Redis, so without this gate a utility-
 * only instance could execute any sibling instance's inverse mutations.
 */

// Importing allTools() loads every defs module, whose side effects populate
// the reverter registry — same bootstrapping revertCoverage.test.ts relies on.
const tools = allTools();
const revertDef = tools.find((t) => t.name === "gojira.revertOperation")!;

// Pick a real revertible tool so assertRevertible passes and the group gate is
// what decides. Derive its group from the def instead of hardcoding.
const revertibleTool = reverters.names().find((n) => tools.some((t) => t.name === n))!;
const revertibleGroup = tools.find((t) => t.name === revertibleTool)!.group;

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    opId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    accountId: "acct-1",
    tool: revertibleTool,
    instance: "gojira-platform",
    cloudId: "cloud-1",
    target: { kind: "test-target", id: "10001" },
    before: { state: "before" },
    after: { state: "after" },
    request: {},
    requestedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: "success",
    revertible: true,
    ...overrides,
  };
}

function makeCtx(enabledGroups: string[], entry: JournalEntry): ToolContext {
  return {
    accountId: "acct-1",
    cloudId: "cloud-1",
    config: { enabledGroups, atlassian: { pinnedCloudId: null } },
    journal: { get: async () => entry },
    journalOp: vi.fn(async () => {
      throw new Error("journalOp must not run when the group gate refuses");
    }),
  } as unknown as ToolContext;
}

describe("gojira.revertOperation — original-tool group gate", () => {
  it("sanity: the sampled reverter belongs to a non-utility group", () => {
    expect(revertibleGroup).not.toBe("utility");
  });

  it("refuses commit when the original tool's group is not enabled, naming the owning instance", async () => {
    const entry = makeEntry();
    const ctx = makeCtx(["utility"], entry);
    await expect(
      revertDef.handler({ op_id: entry.opId, commit: true }, ctx),
    ).rejects.toThrow(new RegExp(`requires group '${revertibleGroup}'`));
    await expect(
      revertDef.handler({ op_id: entry.opId, commit: true }, ctx),
    ).rejects.toThrow(/instance 'gojira-platform'/);
    expect(ctx.journalOp).not.toHaveBeenCalled();
  });

  it("refuses the DRY RUN too — it reveals before/after state the surface never exposed", async () => {
    const entry = makeEntry();
    const ctx = makeCtx(["utility"], entry);
    await expect(revertDef.handler({ op_id: entry.opId }, ctx)).rejects.toThrow(
      /is not enabled on this instance/,
    );
  });

  it("omits the instance hint for entries journaled before the field existed", async () => {
    const entry = makeEntry({ instance: undefined });
    const ctx = makeCtx(["utility"], entry);
    await expect(revertDef.handler({ op_id: entry.opId }, ctx)).rejects.toThrow(
      new RegExp(`requires group '${revertibleGroup}', which is not enabled on this instance\\.$`),
    );
  });

  it("proceeds to the dry-run diff when the original tool's group IS enabled", async () => {
    const entry = makeEntry();
    const ctx = makeCtx(["utility", revertibleGroup], entry);
    const result = (await revertDef.handler({ op_id: entry.opId }, ctx)) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.original).toEqual({ op_id: entry.opId, tool: revertibleTool });
  });

  it("fails closed when the journaled tool no longer resolves to a def", async () => {
    // A reverter can outlive its tool across a rename — simulate that drift.
    reverters.register("ghost.renamedTool", async () => null);
    const entry = makeEntry({ tool: "ghost.renamedTool" });
    const ctx = makeCtx(["utility", revertibleGroup], entry);
    await expect(revertDef.handler({ op_id: entry.opId }, ctx)).rejects.toThrow(
      /Cannot resolve the original tool 'ghost\.renamedTool'/,
    );
  });

  it("reverts pre-collapse journal entries through the legacy alias map", async () => {
    // Simulate a post-collapse deployment: the OLD tool name lives only in a
    // 30-day-old journal entry; the alias maps it onto a live tool + op-keyed
    // reverter. The whole chain — assertRevertible, the group gate, and the
    // dry-run — must resolve through the alias.
    const liveTool = tools.find((t) => t.name === revertibleTool)!;
    registerLegacyAlias("legacy.preCollapseTool", { tool: liveTool.name, op: "legacyOp" });
    reverters.register(`${liveTool.name}#legacyOp`, async () => ({ restored: true }));

    const entry = makeEntry({ tool: "legacy.preCollapseTool" });
    // Wrong surface still refuses — the gate canonicalizes to the live tool's group.
    const denied = makeCtx(["utility"], entry);
    await expect(revertDef.handler({ op_id: entry.opId }, denied)).rejects.toThrow(
      new RegExp(`requires group '${liveTool.group}'`),
    );
    // Owning surface passes the gate and renders the dry-run diff.
    const ctx = makeCtx(["utility", liveTool.group], entry);
    const result = (await revertDef.handler({ op_id: entry.opId }, ctx)) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.original).toEqual({ op_id: entry.opId, tool: "legacy.preCollapseTool" });
  });
});

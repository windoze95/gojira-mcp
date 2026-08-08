import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineOpTool, defineOp } from "../../src/tools/defs/defineOpTool.js";
import { reverters } from "../../src/operations/revert.js";
import { canonicalReverterKey, resolveLegacyAlias } from "../../src/operations/legacyAliases.js";
import type { ToolContext } from "../../src/tools/types.js";

/**
 * The op-tool factory contract: flat plain-ZodObject advertised schema (the
 * SDK advertises `{}` for top-level unions/effects), strict per-op runtime
 * validation, journal request.op injection, dry-run tool-name pre-fill, and
 * the reverter/alias side effects the collapse's revert chain depends on.
 */

const sharedId = z.string().describe("Target thing id");

// No legacyName/revert here — those side effects are keyed per name and are
// exercised in their own describe block; the fixture must stay re-buildable
// under different tool names.
function buildFixture(overrides: Partial<Parameters<typeof defineOpTool>[0]> = {}) {
  const widgetName = z.string().describe("Widget name");
  return defineOpTool({
    name: "test.manageWidget",
    description: "Manage widgets: create a widget or update one.",
    group: "utility",
    authMethod: "none",
    ops: [
      defineOp({
        op: "createWidget",
        description: "Create a widget.",
        input: { name: widgetName, color: z.string().optional() },
        destructive: true,
        handler: async (args, _ctx, meta) => ({ created: args.name, via: meta.op }),
      }),
      defineOp({
        op: "updateWidget",
        description: "Update a widget.",
        input: { widgetId: sharedId, name: widgetName.optional() },
        destructive: true,
        handler: async (args, _ctx, meta) => ({ updated: args.widgetId, via: meta.op }),
      }),
    ],
    ...overrides,
  });
}

function makeCtx(journalCapture?: (args: unknown) => void): ToolContext {
  return {
    accountId: "acct",
    cloudId: "cloud-1",
    config: { enabledGroups: ["utility"] },
    journalOp: vi.fn(async (jArgs: { request?: Record<string, unknown>; run: () => Promise<unknown> }) => {
      journalCapture?.(jArgs);
      const after = await jArgs.run();
      return { after };
    }),
  } as unknown as ToolContext;
}

describe("defineOpTool — advertised schema", () => {
  const def = buildFixture({ name: "test.schemaWidget" });

  it("stays a plain ZodObject with op enum + merged optional fields + commit", () => {
    const shape = (buildFixture({ name: "test.shapeWidget" }).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(shape).toBeDefined();
    expect(Object.keys(shape).sort()).toEqual(["color", "commit", "name", "op", "widgetId"]);
    // op required; per-op fields optional in the merged advertisement.
    expect(shape.op.isOptional()).toBe(false);
    expect(shape.name.isOptional()).toBe(true);
    expect(shape.widgetId.isOptional()).toBe(true);
    expect(shape.commit.isOptional()).toBe(true);
  });

  it("documents ops in the enum description and requiredness on fields", () => {
    const shape = (buildFixture({ name: "test.docsWidget" }).inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    const opDesc = shape.op.description ?? "";
    expect(opDesc).toContain("createWidget(name) [destructive]: Create a widget.");
    expect(opDesc).toContain("updateWidget(widgetId) [destructive]: Update a widget.");
    expect(shape.name.description).toContain("[ops: createWidget!, updateWidget]");
    expect(shape.widgetId.description).toContain("[ops: updateWidget!]");
  });

  it("keeps a field required when every op requires it", () => {
    const def2 = defineOpTool({
      name: "test.alwaysRequired",
      description: "x: a, b.",
      group: "utility",
      authMethod: "none",
      ops: [
        defineOp({ op: "a", description: "a", input: { key: sharedId }, handler: async () => 1 }),
        defineOp({ op: "b", description: "b", input: { key: sharedId }, handler: async () => 2 }),
      ],
    });
    const shape = (def2.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(shape.key.isOptional()).toBe(false);
    expect(shape.commit).toBeUndefined(); // read tool: no commit field
    expect(def2.readOnly).toBe(true);
    expect(def2.destructive).toBe(false);
  });

  it("attaches the machine manifest", () => {
    const ops = def.ops!;
    expect(ops.map((o) => o.op)).toEqual(["createWidget", "updateWidget"]);
    expect(ops[0].claimsRevertible).toBe(false);
    expect(ops[0].destructive).toBe(true);
    expect(ops[0].readOnly).toBe(false);
    expect(Object.keys(ops[0].inputShape)).toEqual(["name", "color"]);
  });
});

describe("defineOpTool — build-time guards", () => {
  const base = {
    description: "d",
    group: "utility" as const,
    authMethod: "none" as const,
  };
  const op = (o: Record<string, unknown>) => o as never;

  it("rejects mixed destructive and read ops", () => {
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.mixed",
        ops: [
          op({ op: "a", description: "a", destructive: true, handler: async () => 1 }),
          op({ op: "b", description: "b", handler: async () => 2 }),
        ],
      }),
    ).toThrow(/mixes destructive and non-destructive/);
  });

  it("rejects same field name with different schema instances", () => {
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.collide",
        ops: [
          op({ op: "a", description: "a", input: { x: z.string() }, handler: async () => 1 }),
          op({ op: "b", description: "b", input: { x: z.number() }, handler: async () => 2 }),
        ],
      }),
    ).toThrow(/different schema instances.*hoist one shared const/s);
  });

  it("rejects distinct fields sharing one zod instance ($ref hazard)", () => {
    const shared = z.string();
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.refhazard",
        ops: [
          op({ op: "a", description: "a", input: { x: shared, y: shared }, handler: async () => 1 }),
          op({ op: "b", description: "b", handler: async () => 2 }),
        ],
      }),
    ).toThrow(/share one zod instance/);
  });

  it("rejects reserved fields, duplicate ops, and out-of-band op counts", () => {
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.reserved",
        ops: [
          op({ op: "a", description: "a", input: { commit: z.boolean() }, handler: async () => 1 }),
          op({ op: "b", description: "b", handler: async () => 2 }),
        ],
      }),
    ).toThrow(/reserved field 'commit'/);
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.dup",
        ops: [
          op({ op: "a", description: "a", handler: async () => 1 }),
          op({ op: "a", description: "a2", handler: async () => 2 }),
        ],
      }),
    ).toThrow(/duplicate op/);
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.single",
        ops: [op({ op: "only", description: "o", handler: async () => 1 })],
      }),
    ).toThrow(/2-7 ops/);
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.toomany",
        ops: Array.from({ length: 8 }, (_, i) =>
          op({ op: `op${i}`, description: "x", handler: async () => i }),
        ),
      }),
    ).toThrow(/2-7 ops/);
  });

  it("rejects admin_org ops carrying reverters", () => {
    expect(() =>
      defineOpTool({
        ...base,
        name: "test.orgRevert",
        group: "admin_org",
        ops: [
          op({ op: "a", description: "a", destructive: true, revert: async () => null, handler: async () => 1 }),
          op({ op: "b", description: "b", destructive: true, handler: async () => 2 }),
        ],
      }),
    ).toThrow(/admin_org ops must not register reverters/);
  });
});

describe("defineOpTool — dispatch", () => {
  it("routes to the op handler with parsed args and meta", async () => {
    const def = buildFixture({ name: "test.dispatchWidget" });
    const result = (await def.handler(
      { op: "createWidget", name: "w1" },
      makeCtx(),
    )) as { created: string; via: string };
    expect(result).toEqual({ created: "w1", via: "createWidget" });
  });

  it("rejects missing per-op required fields, naming the op", async () => {
    const def = buildFixture({ name: "test.missingWidget" });
    await expect(def.handler({ op: "updateWidget" }, makeCtx())).rejects.toThrow(
      /Invalid input for op 'updateWidget'/,
    );
  });

  it("rejects a sibling op's stray field with an ownership hint", async () => {
    const def = buildFixture({ name: "test.strayWidget" });
    const err = await def
      .handler({ op: "createWidget", name: "w", widgetId: "x1" }, makeCtx())
      .then(
        () => null,
        (e: Error & { details?: { issues?: Array<{ message: string }> } }) => e,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Invalid input for op 'createWidget'/);
    const messages = (err!.details?.issues ?? []).map((i) => i.message).join("\n");
    expect(messages).toMatch(/'widgetId' belongs to ops: updateWidget/);
  });

  it("injects request.op into journaled entries and strips commit", async () => {
    let captured: { request?: Record<string, unknown> } | undefined;
    const def = defineOpTool({
      name: "test.journalWidget",
      description: "j: doIt, undoIt.",
      group: "utility",
      authMethod: "none",
      ops: [
        defineOp({
          op: "doIt",
          description: "do",
          input: { thing: z.string() },
          destructive: true,
          handler: async (args, ctx) =>
            ctx.journalOp({
              accountId: "acct",
              tool: "test.journalWidget",
              cloudId: null,
              target: { kind: "widget" },
              before: null,
              request: { thing: args.thing, commit: args.commit },
              revertible: false,
              run: async () => ({ ok: true }),
            }),
        }),
        defineOp({
          op: "undoIt",
          description: "undo",
          destructive: true,
          handler: async () => ({ ok: true }),
        }),
      ],
    });
    await def.handler({ op: "doIt", thing: "t", commit: true }, makeCtx((j) => (captured = j as never)));
    expect(captured?.request).toEqual({ op: "doIt", thing: "t" }); // op injected, commit stripped
  });

  it("pre-fills the collapsed tool name into dry runs and honors commit", async () => {
    const def = defineOpTool({
      name: "test.dryWidget",
      description: "d: mutate, other.",
      group: "utility",
      authMethod: "none",
      ops: [
        defineOp({
          op: "mutate",
          description: "m",
          destructive: true,
          handler: async (_args, _ctx, meta) =>
            meta.dryRun({ target: { kind: "widget" }, before: { a: 1 }, after: { a: 2 } }) ?? {
              committed: true,
            },
        }),
        defineOp({ op: "other", description: "o", destructive: true, handler: async () => ({}) }),
      ],
    });
    const dry = (await def.handler({ op: "mutate" }, makeCtx())) as { dry_run: true; tool: string };
    expect(dry.dry_run).toBe(true);
    expect(dry.tool).toBe("test.dryWidget"); // what the confirm card re-invokes
    const committed = await def.handler({ op: "mutate", commit: true }, makeCtx());
    expect(committed).toEqual({ committed: true });
  });
});

describe("defineOpTool — side effects", () => {
  it("registers reverters under tool#op and aliases from legacyName", async () => {
    const revert = vi.fn(async () => ({ reverted: true }));
    defineOpTool({
      name: "test.sideEffects",
      description: "s: alpha, beta.",
      group: "utility",
      authMethod: "none",
      ops: [
        defineOp({
          op: "alpha",
          description: "a",
          destructive: true,
          legacyName: "test.legacyAlpha",
          revert,
          handler: async () => 1,
        }),
        defineOp({ op: "beta", description: "b", destructive: true, handler: async () => 2 }),
      ],
    });
    expect(reverters.has("test.sideEffects#alpha")).toBe(true);
    expect(resolveLegacyAlias("test.legacyAlpha")).toEqual({ tool: "test.sideEffects", op: "alpha" });

    // The whole legacy revert chain: an OLD-name journal entry resolves to the
    // new tool#op reverter.
    const legacyEntry = { tool: "test.legacyAlpha", request: { thing: "x" } };
    expect(canonicalReverterKey(legacyEntry)).toBe("test.sideEffects#alpha");
    expect(reverters.resolveForEntry(legacyEntry)).toBe(revert);
    // And a NEW entry written by the op tool resolves via request.op.
    expect(reverters.resolveForEntry({ tool: "test.sideEffects", request: { op: "alpha" } })).toBe(revert);
  });

  it("throws when invoked per-call instead of at module level", () => {
    const make = () =>
      defineOpTool({
        name: "test.perCall",
        description: "p: one, two.",
        group: "utility",
        authMethod: "none",
        ops: [
          defineOp({
            op: "one",
            description: "1",
            destructive: true,
            revert: async () => null, // fresh closure per invocation
            handler: async () => 1,
          }),
          defineOp({ op: "two", description: "2", destructive: true, handler: async () => 2 }),
        ],
      });
    make();
    // Second invocation registers a DIFFERENT reverter closure under the same
    // key — the registry rejects it, which is exactly the guard that forces
    // module-level const placement.
    expect(make).toThrow(/already registered .* different function/);
  });
});

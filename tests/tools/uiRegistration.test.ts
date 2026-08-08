import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/defs/defineTool.js";
import { registerWrappedTool } from "../../src/tools/wrapHandler.js";
import {
  AQL_TABLE_UI_URI,
  CONFIRM_OP_UI_URI,
  resolveUiResourceUri,
} from "../../src/ui/appResources.js";
import type { ToolDeps } from "../../src/tools/types.js";

interface CapturedConfig {
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  _meta?: Record<string, unknown>;
}

type WrappedTool = (
  args: unknown,
  extra: { authInfo?: { extra?: Record<string, unknown>; clientId?: string } },
) => Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }>;

function capture(def: ReturnType<typeof defineTool>, uiResourceUri?: string | null) {
  const configs = new Map<string, CapturedConfig>();
  const handlers = new Map<string, WrappedTool>();
  const server = {
    registerTool: (name: string, config: CapturedConfig, cb: WrappedTool) => {
      configs.set(name, config);
      handlers.set(name, cb);
    },
  };
  const deps = {
    config: { enabledGroups: [def.group], orgAdmin: { orgId: null } },
    rateLimiter: { checkLimit: async () => ({ allowed: true }) },
    audit: { emit: () => {} },
    usageMetrics: { record: () => {} },
    journal: {},
  } as unknown as ToolDeps;
  registerWrappedTool(server as never, def as never, deps, {
    clientId: "c1",
    ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
  });
  return { config: configs.get(def.name)!, handler: handlers.get(def.name)! };
}

const destructiveDef = defineTool({
  name: "test.deleteThing",
  description: "destructive",
  group: "utility",
  authMethod: "none",
  destructive: true,
  input: { commit: z.boolean().optional() },
  handler: async () => ({ ok: true }),
});

const readDef = defineTool({
  name: "test.listThings",
  description: "read",
  group: "utility",
  authMethod: "none",
  readOnly: true,
  handler: async () => ({ items: [] }),
});

const writeDef = defineTool({
  name: "test.createThing",
  description: "non-destructive write",
  group: "utility",
  authMethod: "none",
  handler: async () => ({ ok: true }),
});

describe("registerWrappedTool — MCP metadata", () => {
  it("annotates destructive tools truthfully", () => {
    const { config } = capture(destructiveDef);
    expect(config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("annotates explicitly read-only tools", () => {
    const { config } = capture(readDef);
    expect(config.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("leaves unclassified writes unannotated so hosts confirm by default", () => {
    const { config } = capture(writeDef);
    expect(config.annotations).toBeUndefined();
  });

  it("explicit readOnly:true annotates regardless of the leaf verb", () => {
    const def = defineTool({
      name: "test.exportThing",
      description: "read via explicit flag",
      group: "utility",
      authMethod: "none",
      readOnly: true,
      handler: async () => ({ ok: true }),
    });
    const { config } = capture(def);
    expect(config.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  });

  it("leaves flag-less non-destructive tools unannotated — annotations are purely flag-driven", () => {
    const def = defineTool({
      name: "test.listButUnflagged", // a read-looking leaf earns NOTHING without the flag
      description: "no flag, no hint",
      group: "utility",
      authMethod: "none",
      handler: async () => ({ ok: true }),
    });
    const { config } = capture(def);
    expect(config.annotations).toBeUndefined();
  });

  it("declares the output envelope schema on every tool", () => {
    for (const def of [destructiveDef, readDef, writeDef]) {
      const { config } = capture(def);
      expect(config.outputSchema).toBeDefined();
    }
  });

  it("links the UI template via _meta (standard + legacy key) when provided", () => {
    const { config } = capture(destructiveDef, CONFIRM_OP_UI_URI);
    expect(config._meta).toEqual({
      ui: { resourceUri: CONFIRM_OP_UI_URI },
      "ui/resourceUri": CONFIRM_OP_UI_URI,
    });
  });

  it("emits no _meta when UI is inactive", () => {
    expect(capture(destructiveDef, null).config._meta).toBeUndefined();
    expect(capture(destructiveDef).config._meta).toBeUndefined();
  });
});

describe("registerWrappedTool — structuredContent envelope", () => {
  const extra = { authInfo: { extra: { accountId: "acct-1" }, clientId: "c1" } };

  it("mirrors the success envelope into structuredContent", async () => {
    const { handler } = capture(readDef);
    const result = await handler({}, extra);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ success: true, result: { items: [] } });
  });

  it("mirrors the error envelope into structuredContent", async () => {
    const { handler } = capture(readDef);
    const result = await handler({}, { authInfo: { extra: {}, clientId: "c1" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.error).toBeDefined();
  });
});

describe("resolveUiResourceUri", () => {
  it("prefers an explicit def.ui, defaults destructive tools to the confirm card", () => {
    const explicit = defineTool({
      name: "test.aqlSearch",
      description: "x",
      group: "read_assets",
      authMethod: "oauth",
      ui: { resourceUri: AQL_TABLE_UI_URI },
      handler: async () => ({}),
    });
    expect(resolveUiResourceUri(explicit)).toBe(AQL_TABLE_UI_URI);
    expect(resolveUiResourceUri(destructiveDef)).toBe(CONFIRM_OP_UI_URI);
    expect(resolveUiResourceUri(readDef)).toBeNull();
  });
});

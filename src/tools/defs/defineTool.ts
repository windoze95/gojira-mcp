import { z } from "zod";
import type { ToolContext, ToolDefinition, AuthMethod, PermissionGroup } from "../types.js";
import { registerLegacyAlias } from "../../operations/legacyAliases.js";

export interface DefineToolArgs<Shape extends z.ZodRawShape, Output> {
  name: string;
  description: string;
  group: PermissionGroup;
  authMethod: AuthMethod;
  destructive?: boolean;
  needsCloudId?: boolean;
  /** Explicit read-only marker for annotations; wins over the leaf-verb regex. */
  readOnly?: boolean;
  /**
   * Pre-collapse name of this tool when it is a 1:1 RENAME (no op field).
   * Registers a legacy alias so pre-rename journal entries stay revertible.
   */
  legacyName?: string;
  /** MCP Apps template for UI-capable hosts; see ToolDefinition.ui. */
  ui?: { resourceUri: string };
  input?: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<Output>;
}

/**
 * Shape-erased tool definition. The author-facing type is `ToolDefinition<ZodObject<Shape>, Output>`
 * for full inference inside the handler. For storage in the global registry
 * array we widen to a `ZodTypeAny`-shaped definition so the array is uniform.
 *
 * The wrapper still treats the schema as a ZodObject at runtime — that's
 * guaranteed by the fact that defineTool() always wraps `input` in `z.object`.
 */
export type AnyToolDef = ToolDefinition<z.ZodTypeAny, unknown>;

export function defineTool<Shape extends z.ZodRawShape, Output>(
  args: DefineToolArgs<Shape, Output>,
): AnyToolDef {
  const inputSchema = z.object((args.input ?? ({} as Shape)) as Shape);
  const def: ToolDefinition<z.ZodObject<Shape>, Output> = {
    name: args.name,
    description: args.description,
    group: args.group,
    authMethod: args.authMethod,
    destructive: args.destructive ?? false,
    needsCloudId: args.needsCloudId ?? false,
    ...(args.readOnly !== undefined ? { readOnly: args.readOnly } : {}),
    ...(args.ui ? { ui: args.ui } : {}),
    inputSchema,
    handler: args.handler,
  };
  if (args.legacyName) {
    // op:null — the renamed tool has no op field; its reverter (if any) stays
    // keyed by the bare new name. Idempotent across repeated allTools() calls.
    registerLegacyAlias(args.legacyName, { tool: args.name, op: null });
  }
  // Variance-safe widening: callers store these in a homogeneous array.
  return def as unknown as AnyToolDef;
}

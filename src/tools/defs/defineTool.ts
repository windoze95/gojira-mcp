import { z } from "zod";
import type { ToolContext, ToolDefinition, AuthMethod, PermissionGroup } from "../types.js";

export interface DefineToolArgs<Shape extends z.ZodRawShape, Output> {
  name: string;
  description: string;
  group: PermissionGroup;
  authMethod: AuthMethod;
  destructive?: boolean;
  needsCloudId?: boolean;
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
    inputSchema,
    handler: args.handler,
  };
  // Variance-safe widening: callers store these in a homogeneous array.
  return def as unknown as AnyToolDef;
}

import { z } from "zod";
import type { ToolContext, OpManifestEntry } from "../types.js";
import { defineTool, type AnyToolDef } from "./defineTool.js";
import type { AuthMethod, PermissionGroup } from "../types.js";
import { ValidationError } from "../../middleware/errorHandler.js";
import { buildDryRunIfNotCommitted, buildDeleteDryRun, type DryRunResult } from "../../consent/dryRun.js";
import { reverters, type ReverterFn } from "../../operations/revert.js";
import { registerLegacyAlias } from "../../operations/legacyAliases.js";

/**
 * Op-parameterized tools: one MCP tool carrying several operations selected by
 * a required `op` enum, collapsing the per-endpoint catalog while keeping the
 * SDK contract (the advertised input stays a plain z.object — a top-level
 * union/effects schema is advertised as `{}` by the SDK's ListTools handler).
 *
 * MUST be invoked at MODULE level (a `const` beside the module's exported
 * tools() function), never inside it: the factory registers reverters and
 * legacy aliases as side effects, and the reverter registry rejects a second
 * registration with a different function instance — which is exactly what a
 * per-call invocation would produce. Any test that builds two sessions
 * (tests/server/multiInstance.test.ts) trips this immediately.
 *
 * Authoring rules the factory enforces:
 * - 2..7 ops, unique names, none named `op`/`commit`.
 * - Homogeneous destructiveness: a tool is all-destructive or all-read.
 *   (Mixing would attach the confirm-op card to read results.)
 * - A field name shared by several ops must reuse ONE hoisted zod instance
 *   (same required-ness semantics everywhere); distinct field names must NOT
 *   share an instance (zod-to-json-schema dedups shared instances into $refs).
 * - admin_org ops may not register reverters (module-wide invariant).
 */

export interface OpMeta {
  tool: string;
  op: string;
  /**
   * Commit-positive dry run pre-filled with this tool's name — `dry_run.tool`
   * is what the confirm card re-invokes, so it must always name the live tool.
   * Returns null when the caller passed `commit: true`.
   */
  dryRun(args: {
    target: DryRunResult["target"];
    before: unknown;
    after: unknown;
    message?: string;
    includeFullState?: boolean;
  }): DryRunResult | null;
  /** Delete-flavored dry run (no after-state); caller guards on `commit` itself. */
  deleteDryRun(args: {
    target: DryRunResult["target"];
    before: unknown;
    message?: string;
  }): DryRunResult;
}

export interface OpSpec<Shape extends z.ZodRawShape = z.ZodRawShape, Output = unknown> {
  /** Op enum value — the legacy tool's leaf verbatim (createObjectSchema, ...). */
  op: string;
  /** One compact line; long-form operational contracts go here verbatim. */
  description: string;
  /** Per-op raw shape with REAL required-ness (advertised merged as optional). */
  input?: Shape;
  destructive?: boolean;
  /** Pre-collapse tool name this op absorbs — feeds the legacy alias map. */
  legacyName?: string;
  /** Reverter for this op, registered under `${tool}#${op}`. */
  revert?: ReverterFn;
  /**
   * Declares the op journals revertible:true. Defaults to !!revert; set
   * explicitly for conditional revertibility so the coverage test knows.
   */
  claimsRevertible?: boolean;
  handler: (
    args: z.infer<z.ZodObject<Shape>> & { commit?: boolean },
    ctx: ToolContext,
    meta: OpMeta,
  ) => Promise<Output>;
}

/** Identity helper for authoring: full inference inside the op handler. */
export function defineOp<Shape extends z.ZodRawShape, Output>(
  spec: OpSpec<Shape, Output>,
): OpSpec {
  return spec as unknown as OpSpec;
}

export interface DefineOpToolArgs {
  name: string;
  /**
   * Prose summary that ENUMERATES the ops ("Manage permission schemes:
   * create, update, or assign one to a project."). This is the selection
   * index for models and tool search — names like `schemes.manage` carry no
   * information by themselves.
   */
  description: string;
  group: PermissionGroup;
  authMethod: AuthMethod;
  needsCloudId?: boolean;
  ui?: { resourceUri: string };
  ops: OpSpec[];
}

const OPS_MIN = 2;
const OPS_MAX = 7;

function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  return schema.isOptional();
}

function requiredKeys(shape: z.ZodRawShape): string[] {
  return Object.keys(shape).filter((k) => !isOptionalSchema(shape[k]));
}

/**
 * Strips optional/default/nullable wrappers so ops can declare the SAME base
 * schema with different required-ness (`serviceDeskId` required here, its
 * `.optional()` there) while identity checks still see one hoisted const.
 */
function unwrapBase(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) {
      cur = cur.unwrap() as z.ZodTypeAny;
    } else if (cur instanceof z.ZodDefault) {
      cur = (cur as z.ZodDefault<z.ZodTypeAny>).removeDefault();
    } else {
      return cur;
    }
  }
}

export function defineOpTool(args: DefineOpToolArgs): AnyToolDef {
  const { name, ops } = args;
  if (ops.length < OPS_MIN || ops.length > OPS_MAX) {
    throw new Error(
      `${name}: ${ops.length} ops — op tools carry ${OPS_MIN}-${OPS_MAX} ops; use defineTool for singles, split the cell along sub-domain lines above ${OPS_MAX}`,
    );
  }
  const opNames = ops.map((o) => o.op);
  if (new Set(opNames).size !== opNames.length) {
    throw new Error(`${name}: duplicate op names`);
  }

  const destructiveOps = ops.filter((o) => o.destructive === true);
  if (destructiveOps.length !== 0 && destructiveOps.length !== ops.length) {
    throw new Error(
      `${name}: mixes destructive and non-destructive ops — the confirm-op card would mislabel read results; keep read ops in a separate tool`,
    );
  }
  const destructive = destructiveOps.length === ops.length;

  if (args.group === "admin_org") {
    const withRevert = ops.filter((o) => o.revert);
    if (withRevert.length > 0) {
      throw new Error(
        `${name}: admin_org ops must not register reverters (${withRevert.map((o) => o.op).join(", ")})`,
      );
    }
  }

  // ---- merged advertised shape -------------------------------------------
  // Same-name fields must share ONE hoisted base schema (required-ness
  // wrappers may differ per op); distinct field names must NOT share a base
  // (zod-to-json-schema dedups shared instances into $refs).
  const fieldInfo = new Map<
    string,
    { base: z.ZodTypeAny; declared: z.ZodTypeAny; usedBy: Array<{ op: string; required: boolean }> }
  >();
  const seenBases = new Map<z.ZodTypeAny, string>(); // base instance -> first field name
  for (const spec of ops) {
    const shape = spec.input ?? {};
    for (const [field, schema] of Object.entries(shape)) {
      if (field === "op" || field === "commit") {
        throw new Error(`${name}#${spec.op}: op inputs may not declare the reserved field '${field}'`);
      }
      const base = unwrapBase(schema);
      const info = fieldInfo.get(field);
      if (info) {
        if (info.base !== base) {
          throw new Error(
            `${name}: field '${field}' declared with different schema instances across ops ` +
              `(${info.usedBy.map((u) => u.op).join(", ")} vs ${spec.op}) — hoist one shared const`,
          );
        }
        info.usedBy.push({ op: spec.op, required: !isOptionalSchema(schema) });
      } else {
        const firstOwner = seenBases.get(base);
        if (firstOwner && firstOwner !== field) {
          throw new Error(
            `${name}: fields '${firstOwner}' and '${field}' share one zod instance — ` +
              `zod-to-json-schema would emit a $ref for the second; build a fresh instance per field`,
          );
        }
        seenBases.set(base, field);
        fieldInfo.set(field, {
          base,
          declared: schema,
          usedBy: [{ op: spec.op, required: !isOptionalSchema(schema) }],
        });
      }
    }
  }

  const opEnumDescription =
    "Operation to perform:\n" +
    ops
      .map((o) => {
        const req = requiredKeys(o.input ?? {});
        const sig = req.length > 0 ? `(${req.join(", ")})` : "";
        return `- ${o.op}${sig}${o.destructive ? " [destructive]" : ""}: ${o.description}`;
      })
      .join("\n");

  const mergedShape: z.ZodRawShape = {
    op: z.enum(opNames as [string, ...string[]]).describe(opEnumDescription),
  };
  for (const [field, info] of fieldInfo) {
    const everyOpUsesIt = info.usedBy.length === ops.length;
    const requiredEverywhere = info.usedBy.every((u) => u.required);
    const tag = ` [ops: ${info.usedBy.map((u) => `${u.op}${u.required ? "!" : ""}`).join(", ")}]`;
    const baseDescription = info.base.description ?? info.declared.description ?? "";
    const described = info.base.describe(`${baseDescription}${tag}`.trim());
    // Always an OUTER .optional() unless required by (and present in) every
    // op: the outer optional short-circuits on undefined, so a ZodDefault in
    // the per-op declaration never injects a value at the merged parse — a
    // stray defaulted field would fail the sibling op's strict parse.
    mergedShape[field] = everyOpUsesIt && requiredEverywhere ? described : described.optional();
  }
  if (destructive) {
    mergedShape.commit = z
      .boolean()
      .optional()
      .describe("Set true to apply the mutation; omit for a commit-positive dry-run preview.");
  }

  // ---- strict per-op validation schemas ----------------------------------
  const strictSchemas = new Map<string, z.ZodTypeAny>();
  for (const spec of ops) {
    strictSchemas.set(
      spec.op,
      z
        .object({
          op: z.literal(spec.op),
          ...(spec.input ?? {}),
          ...(destructive ? { commit: z.boolean().optional() } : {}),
        })
        .strict(),
    );
  }
  const specByOp = new Map(ops.map((o) => [o.op, o]));
  const fieldOwners = (field: string): string[] =>
    fieldInfo.get(field)?.usedBy.map((u) => u.op) ?? [];

  // ---- manifest + side-effect registrations ------------------------------
  const manifest: OpManifestEntry[] = ops.map((o) => ({
    op: o.op,
    description: o.description,
    destructive: o.destructive === true,
    readOnly: o.destructive !== true,
    ...(o.legacyName ? { legacyName: o.legacyName } : {}),
    inputShape: o.input ?? {},
    claimsRevertible: o.claimsRevertible ?? !!o.revert,
  }));
  for (const spec of ops) {
    if (spec.revert) reverters.register(`${name}#${spec.op}`, spec.revert);
    if (spec.legacyName) registerLegacyAlias(spec.legacyName, { tool: name, op: spec.op });
  }

  const def = defineTool({
    name,
    description: args.description,
    group: args.group,
    authMethod: args.authMethod,
    destructive,
    needsCloudId: args.needsCloudId,
    readOnly: !destructive,
    ...(args.ui ? { ui: args.ui } : {}),
    input: mergedShape,
    handler: async (input: Record<string, unknown>, ctx: ToolContext) => {
      const opValue = input.op as string;
      const spec = specByOp.get(opValue);
      // Unreachable in practice — the merged enum already validated `op` — but
      // fail closed rather than dispatch nowhere.
      if (!spec) throw new ValidationError(`Unknown op '${String(opValue)}' for ${name}.`);

      const parsed = strictSchemas.get(opValue)!.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => {
          if (i.code === "unrecognized_keys") {
            const hints = i.keys.map((k) => {
              const owners = fieldOwners(k);
              return owners.length > 0 ? `'${k}' belongs to ops: ${owners.join(", ")}` : `'${k}' is not a field of any op`;
            });
            return { path: "(root)", message: `Unexpected fields for op '${opValue}' — ${hints.join("; ")}` };
          }
          return { path: i.path.join("."), message: i.message };
        });
        throw new ValidationError(`Invalid input for op '${opValue}' of ${name}.`, { op: opValue, issues });
      }

      // Every journal entry from an op tool carries a flat top-level
      // request.op (reverter resolution reads it); `commit` never journals.
      const opCtx: ToolContext = {
        ...ctx,
        journalOp: (jArgs) => {
          const { commit: _commit, ...request } = (jArgs.request ?? {}) as Record<string, unknown>;
          return ctx.journalOp({ ...jArgs, request: { op: spec.op, ...request } });
        },
      };

      const meta: OpMeta = {
        tool: name,
        op: spec.op,
        dryRun: (a) => buildDryRunIfNotCommitted({ commit: (parsed.data as { commit?: boolean }).commit }, { tool: name, ...a }),
        deleteDryRun: (a) => buildDeleteDryRun({ tool: name, ...a }),
      };
      return spec.handler(parsed.data as never, opCtx, meta);
    },
  });

  return Object.assign(def, { ops: manifest }) as AnyToolDef;
}

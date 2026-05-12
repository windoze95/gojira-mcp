import { generateJsonPatch, type JsonPatchOp } from "./jsonPatch.js";

export interface DryRunResult {
  dry_run: true;
  tool: string;
  message: string;
  target: { kind: string; id?: string; key?: string; name?: string } & Record<string, unknown>;
  diff: {
    /** RFC 6902 JSON Patch (preferred). */
    patch?: JsonPatchOp[];
    /** Full-before / full-after fallback when patches are not meaningful. */
    before?: unknown;
    after?: unknown;
  };
  commit_hint: string;
}

export interface CommitInput {
  commit?: boolean;
}

/**
 * D5 — commit-positive consent for destructive writes.
 *
 * Returns a dry-run payload if `commit !== true`; otherwise returns `null`
 * to tell the caller to proceed with the actual mutation.
 */
export function buildDryRunIfNotCommitted(
  input: CommitInput,
  args: {
    tool: string;
    target: DryRunResult["target"];
    before: unknown;
    after: unknown;
    message?: string;
    /** When true, emit before+after blobs alongside the patch. */
    includeFullState?: boolean;
  },
): DryRunResult | null {
  if (input.commit === true) return null;
  const patch = generateJsonPatch(args.before, args.after);
  const includeFull = args.includeFullState ?? false;
  return {
    dry_run: true,
    tool: args.tool,
    message:
      args.message ??
      "This call would mutate Atlassian state. Re-invoke with `commit: true` to apply the diff below.",
    target: args.target,
    diff: {
      patch,
      ...(includeFull ? { before: args.before, after: args.after } : {}),
    },
    commit_hint: "Re-invoke this tool with the same arguments and `commit: true` to apply.",
  };
}

/**
 * For mutations where there is no meaningful "before/after" payload (e.g.,
 * delete operations), emit a stripped-down dry-run that names the target.
 */
export function buildDeleteDryRun(args: {
  tool: string;
  target: DryRunResult["target"];
  before: unknown;
  message?: string;
}): DryRunResult {
  return {
    dry_run: true,
    tool: args.tool,
    message:
      args.message ??
      "This call would DELETE the target below. Re-invoke with `commit: true` to apply.",
    target: args.target,
    diff: { before: args.before, after: null },
    commit_hint: "Re-invoke this tool with `commit: true` to perform the deletion.",
  };
}

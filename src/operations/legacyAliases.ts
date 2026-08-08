import type { JournalEntry } from "./journal.js";

/**
 * Maps pre-collapse tool names to their post-collapse destination so journal
 * entries written before the CRUD collapse (30-day TTL) stay revertible.
 *
 * Populated automatically from `legacyName` declarations in defineTool /
 * defineOpTool specs — never hand-maintained, so it cannot drift from the
 * live catalog. Deliberately SEPARATE from the reverter registry: an unknown
 * tool name with no alias still fails closed in gojira.revertOperation, and
 * alias names never appear as registered reverter keys.
 *
 * Retirement: deletable ≥60 days after the last conversion ships (journal TTL
 * 30d + slack). Until then it doubles as the audit/SIEM old→new name table.
 */
export interface LegacyAlias {
  /** Post-collapse tool name. */
  tool: string;
  /** Op within that tool, or null for 1:1 renames (no op field). */
  op: string | null;
}

const LEGACY_TOOL_ALIASES = new Map<string, LegacyAlias>();

/**
 * Idempotent: defs modules re-run their define* calls on every allTools()
 * invocation, so re-registering the identical mapping is a no-op. A DIFFERENT
 * mapping for the same legacy name is a wiring bug — fail loudly at load.
 */
export function registerLegacyAlias(legacyName: string, alias: LegacyAlias): void {
  const existing = LEGACY_TOOL_ALIASES.get(legacyName);
  if (existing) {
    if (existing.tool === alias.tool && existing.op === alias.op) return;
    throw new Error(
      `Legacy alias conflict for '${legacyName}': already → ${existing.tool}#${existing.op ?? ""}, ` +
        `now → ${alias.tool}#${alias.op ?? ""}`,
    );
  }
  LEGACY_TOOL_ALIASES.set(legacyName, alias);
}

export function resolveLegacyAlias(legacyName: string): LegacyAlias | null {
  return LEGACY_TOOL_ALIASES.get(legacyName) ?? null;
}

/** Read-only view for docs generation and coverage tests. */
export function allLegacyAliases(): ReadonlyMap<string, LegacyAlias> {
  return LEGACY_TOOL_ALIASES;
}

/**
 * The post-collapse tool name a journal entry's tool resolves to — for the
 * revertOperation group gate (which looks the def up in allTools()).
 */
export function canonicalToolName(entry: Pick<JournalEntry, "tool">): string {
  return resolveLegacyAlias(entry.tool)?.tool ?? entry.tool;
}

/**
 * The reverter-registry key for a journal entry:
 * - new op-tool entries: `${tool}#${request.op}`
 * - new single-op entries (no request.op): bare tool name
 * - pre-collapse entries: via the alias (`tool#op` or bare rename target)
 * Unknown names fall through to the bare name, which is unregistered → the
 * revert path fails closed exactly as before.
 */
export function canonicalReverterKey(entry: Pick<JournalEntry, "tool" | "request">): string {
  const requestOp = entry.request?.op;
  if (typeof requestOp === "string" && requestOp.length > 0) {
    return `${entry.tool}#${requestOp}`;
  }
  const alias = resolveLegacyAlias(entry.tool);
  if (alias) return alias.op ? `${alias.tool}#${alias.op}` : alias.tool;
  return entry.tool;
}

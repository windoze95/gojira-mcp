import type { JournalEntry } from "./journal.js";
import { ValidationError } from "../middleware/errorHandler.js";
import { canonicalReverterKey } from "./legacyAliases.js";

/**
 * A reverter is bound to a (tool, target.kind) pair. It receives the journal
 * entry of the original op and the per-call ToolContext, and performs the
 * inverse mutation. Reverters do NOT journal themselves and are not dispatched
 * through the normal tool path: gojira.revertOperation invokes the resolved
 * reverter inside its own ctx.journalOp, which writes one `gojira.revertOperation`
 * entry (target = the original op's target, before = the original op's after-state,
 * after = the reverter's return value, revertible = false).
 *
 * Examples of revertible ops:
 *   - custom field create  → delete the field
 *   - automation rule disable → re-enable
 *   - permission scheme assignment → re-assign prior
 *   - queue create → delete the queue
 */
export type ReverterId = string;

export type ReverterFn = (entry: JournalEntry, ctx: unknown) => Promise<unknown>;

class ReverterRegistry {
  private readonly reverters = new Map<ReverterId, ReverterFn>();

  /**
   * Keys are bare tool names for single-op tools and `${tool}#${op}` for
   * op-parameterized tools ('#' cannot occur in either). Idempotent re-register
   * of the SAME function is a no-op (defs modules re-run their define* calls on
   * every allTools() invocation); a different function under an existing key is
   * a wiring bug.
   */
  register(key: string, fn: ReverterFn): void {
    const existing = this.reverters.get(key);
    if (existing) {
      if (existing === fn) return;
      throw new Error(`Reverter already registered for '${key}' with a different function`);
    }
    this.reverters.set(key, fn);
  }

  resolve(key: string): ReverterFn | null {
    return this.reverters.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.reverters.has(key);
  }

  /** Entry-aware resolution: new entries via request.op, legacy via alias map. */
  hasForEntry(entry: Pick<JournalEntry, "tool" | "request">): boolean {
    return this.reverters.has(canonicalReverterKey(entry));
  }

  resolveForEntry(entry: Pick<JournalEntry, "tool" | "request">): ReverterFn | null {
    return this.reverters.get(canonicalReverterKey(entry)) ?? null;
  }

  /** Registered keys (tool names / tool#op) — used to audit revert coverage. */
  names(): string[] {
    return [...this.reverters.keys()];
  }
}

export const reverters = new ReverterRegistry();

/**
 * Asserts that an entry is eligible for revert.
 */
export function assertRevertible(entry: JournalEntry): void {
  if (!entry.revertible) {
    throw new ValidationError("This operation is not revertible.", {
      reason: entry.revertHint ?? "Marked irreversible in the journal.",
    });
  }
  if (entry.outcome !== "success") {
    throw new ValidationError("Cannot revert an operation that did not succeed.", {
      outcome: entry.outcome,
    });
  }
  if (!reverters.hasForEntry(entry)) {
    throw new ValidationError(
      `No reverter registered for tool '${entry.tool}'. This operation cannot be undone via revertOperation.`,
    );
  }
}

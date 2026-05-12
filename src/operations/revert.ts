import type { JournalEntry } from "./journal.js";
import { ValidationError } from "../middleware/errorHandler.js";

/**
 * A reverter is bound to a (tool, target.kind) pair. It receives the journal
 * entry of the original op and the per-call ToolContext, and performs the
 * inverse mutation. The reverter itself runs through the normal tool path
 * (so it gets journaled too).
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

  register(toolName: string, fn: ReverterFn): void {
    this.reverters.set(toolName, fn);
  }

  resolve(toolName: string): ReverterFn | null {
    return this.reverters.get(toolName) ?? null;
  }

  has(toolName: string): boolean {
    return this.reverters.has(toolName);
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
  if (!reverters.has(entry.tool)) {
    throw new ValidationError(
      `No reverter registered for tool '${entry.tool}'. This operation cannot be undone via revertOperation.`,
    );
  }
}

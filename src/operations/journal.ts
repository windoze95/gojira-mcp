import { randomUUID } from "node:crypto";
import type { RedisType } from "../redis/client.js";

export type JournalOutcome = "success" | "failure" | "dry_run";

export interface JournalEntry {
  opId: string;
  accountId: string;
  tool: string;
  cloudId: string | null;
  target: { kind: string; id?: string; key?: string; name?: string } & Record<string, unknown>;
  before: unknown;
  after: unknown;
  request: Record<string, unknown>;
  requestedAt: string;
  completedAt: string;
  outcome: JournalOutcome;
  revertible: boolean;
  revertHint?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface NewOperationArgs {
  accountId: string;
  tool: string;
  cloudId: string | null;
  target: JournalEntry["target"];
  before: unknown;
  request: Record<string, unknown>;
  revertible: boolean;
  revertHint?: string;
}

export class OperationJournal {
  constructor(
    private readonly redis: RedisType,
    private readonly ttlDays: number,
  ) {}

  private journalKey(accountId: string, opId: string): string {
    return `op_journal:${accountId}:${opId}`;
  }
  private indexKey(accountId: string): string {
    return `op_journal_idx:${accountId}`;
  }

  private ttlSeconds(): number {
    return this.ttlDays * 24 * 60 * 60;
  }

  /**
   * Captures before-state ahead of a mutation. Returns an `opId` the caller
   * must pass back to complete() once the mutation succeeds (or fails).
   * We don't persist until complete() so a thrown error before the mutation
   * doesn't litter the journal with half-formed records.
   */
  async begin(_args: NewOperationArgs): Promise<string> {
    return randomUUID();
  }

  async complete(
    opId: string,
    args: NewOperationArgs & { after: unknown; outcome: JournalOutcome; error?: { code: string; message: string } },
  ): Promise<JournalEntry> {
    const entry: JournalEntry = {
      opId,
      accountId: args.accountId,
      tool: args.tool,
      cloudId: args.cloudId,
      target: args.target,
      before: args.before,
      after: args.after,
      request: args.request,
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outcome: args.outcome,
      revertible: args.revertible && args.outcome === "success",
    };
    if (args.revertHint) entry.revertHint = args.revertHint;
    if (args.error) {
      entry.errorCode = args.error.code;
      entry.errorMessage = args.error.message;
    }
    const ttl = this.ttlSeconds();
    const pipeline = this.redis.pipeline();
    pipeline.set(this.journalKey(args.accountId, opId), JSON.stringify(entry), "EX", ttl);
    const score = Date.parse(entry.completedAt);
    pipeline.zadd(this.indexKey(args.accountId), score, opId);
    pipeline.expire(this.indexKey(args.accountId), ttl);
    await pipeline.exec();
    return entry;
  }

  async get(accountId: string, opId: string): Promise<JournalEntry | null> {
    const raw = await this.redis.get(this.journalKey(accountId, opId));
    if (!raw) return null;
    return JSON.parse(raw) as JournalEntry;
  }

  async list(
    accountId: string,
    opts: { limit?: number; sinceUnixMs?: number; untilUnixMs?: number } = {},
  ): Promise<JournalEntry[]> {
    const limit = opts.limit ?? 25;
    const min = opts.sinceUnixMs ?? "-inf";
    const max = opts.untilUnixMs ?? "+inf";
    const ids = await this.redis.zrevrangebyscore(
      this.indexKey(accountId),
      max as number | "+inf",
      min as number | "-inf",
      "LIMIT",
      0,
      limit,
    );
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.get(this.journalKey(accountId, id));
    const rows = await pipeline.exec();
    const out: JournalEntry[] = [];
    for (const r of rows ?? []) {
      if (!r) continue;
      const [, val] = r;
      if (typeof val !== "string") continue;
      try {
        out.push(JSON.parse(val) as JournalEntry);
      } catch {
        // skip corrupt entry
      }
    }
    return out;
  }
}

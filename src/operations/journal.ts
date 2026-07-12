import { randomUUID } from "node:crypto";
import type { RedisType } from "../redis/client.js";
import { logger } from "../utils/logger.js";

export type JournalOutcome = "success" | "failure" | "dry_run" | "pending";

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
   * Write-ahead: persists a `pending` record capturing before-state BEFORE the
   * mutation runs, and returns its `opId`. If the process crashes or Redis
   * fails between the mutation and complete(), the pending record survives as
   * evidence the operation may have executed — rather than a silent gap.
   *
   * A Redis failure here throws (the caller aborts before mutating), which is
   * correct: no unrecorded mutation. Pass `opId` to correlate with the audit
   * trail's operation_id.
   */
  async begin(args: NewOperationArgs, opId: string = randomUUID()): Promise<string> {
    const now = new Date().toISOString();
    const entry: JournalEntry = {
      opId,
      accountId: args.accountId,
      tool: args.tool,
      cloudId: args.cloudId,
      target: args.target,
      before: args.before,
      after: null,
      request: args.request,
      requestedAt: now,
      completedAt: now,
      outcome: "pending",
      revertible: false,
    };
    if (args.revertHint) entry.revertHint = args.revertHint;
    const ttl = this.ttlSeconds();
    const pipeline = this.redis.pipeline();
    pipeline.set(this.journalKey(args.accountId, opId), JSON.stringify(entry), "EX", ttl);
    pipeline.zadd(this.indexKey(args.accountId), Date.parse(now), opId);
    pipeline.expire(this.indexKey(args.accountId), ttl);
    await pipeline.exec();
    return opId;
  }

  async complete(
    opId: string,
    args: NewOperationArgs & { after: unknown; outcome: JournalOutcome; error?: { code: string; message: string } },
  ): Promise<JournalEntry> {
    const existing = await this.get(args.accountId, opId).catch(() => null);
    const requestedAt = existing?.requestedAt ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    const entry: JournalEntry = {
      opId,
      accountId: args.accountId,
      tool: args.tool,
      cloudId: args.cloudId,
      target: args.target,
      before: args.before,
      after: args.after,
      request: args.request,
      requestedAt,
      completedAt,
      outcome: args.outcome,
      revertible: args.revertible && args.outcome === "success",
    };
    if (args.revertHint) entry.revertHint = args.revertHint;
    if (args.error) {
      entry.errorCode = args.error.code;
      entry.errorMessage = args.error.message;
    }
    const ttl = this.ttlSeconds();
    // Best-effort: the mutation already happened. A Redis failure here must NOT
    // surface as a tool failure (that would report a successful write as failed).
    // The pending record from begin() remains as the durable trace.
    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(this.journalKey(args.accountId, opId), JSON.stringify(entry), "EX", ttl);
      pipeline.zadd(this.indexKey(args.accountId), Date.parse(completedAt), opId);
      pipeline.expire(this.indexKey(args.accountId), ttl);
      await pipeline.exec();
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), opId, tool: args.tool, outcome: args.outcome },
        "Failed to finalize operation journal entry (mutation outcome stands; pending record retained)",
      );
    }
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

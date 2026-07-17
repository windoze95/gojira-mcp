import type { RedisType } from "../redis/client.js";
import { logger } from "../utils/logger.js";

const DAY_SECONDS = 86400;
const DEFAULT_RETENTION_DAYS = 400;
export const MAX_SUMMARY_DAYS = 400;

export interface UsageCounts {
  calls: number;
  errors: number;
}

export interface UsageSummary {
  days: number;
  from: string;
  to: string;
  totals: UsageCounts;
  byTool: Record<string, UsageCounts>;
  byUser: Record<string, UsageCounts>;
  byDay: Record<string, UsageCounts>;
  byToolUser: Record<string, Record<string, UsageCounts>>;
}

function utcDay(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * DAY_SECONDS * 1000)
    .toISOString()
    .slice(0, 10);
}

// "|" separates tool and account in hash fields, so strip it from inputs.
function sanitizeField(value: string): string {
  return value.replaceAll("|", "_");
}

function emptyCounts(): UsageCounts {
  return { calls: 0, errors: 0 };
}

/**
 * Durable per-day tool-usage counters. The audit sink is fire-and-forget to an
 * external target and can't be queried back, so these Redis hashes are the
 * queryable record of who used which tool when.
 *
 * Keys: `metrics:calls:<YYYY-MM-DD>` / `metrics:errors:<YYYY-MM-DD>` (UTC),
 * hash field `<toolName>|<accountId>` → count. Every write refreshes the
 * day-key TTL, but since a day key only receives writes during its own UTC
 * day, retention is effectively day + retentionDays. TTLs are mandatory here:
 * the Redis deployment runs noeviction, so unbounded keys would pressure the
 * credential store.
 */
export class UsageMetrics {
  constructor(
    private redis: RedisType,
    private retentionDays: number = DEFAULT_RETENTION_DAYS,
  ) {}

  private dayKey(kind: "calls" | "errors", day: string): string {
    return `metrics:${kind}:${day}`;
  }

  /**
   * Fire-and-forget increment; must never throw or delay a tool call.
   * Callers only record calls that resolved an authenticated accountId.
   */
  record(toolName: string, accountId: string, ok: boolean): void {
    try {
      const key = this.dayKey(ok ? "calls" : "errors", utcDay());
      const field = `${sanitizeField(toolName)}|${sanitizeField(accountId)}`;
      this.redis
        .multi()
        .hincrby(key, field, 1)
        .expire(key, this.retentionDays * DAY_SECONDS)
        .exec()
        .catch((err: unknown) => {
          logger.debug({ err }, "Usage metrics increment failed");
        });
    } catch (err) {
      logger.debug({ err }, "Usage metrics increment failed");
    }
  }

  async summary(days: number): Promise<UsageSummary> {
    const window = Math.min(Math.max(Math.trunc(days), 1), MAX_SUMMARY_DAYS);
    const dayList: string[] = [];
    for (let i = 0; i < window; i++) {
      dayList.push(utcDay(i));
    }

    const pipeline = this.redis.pipeline();
    for (const day of dayList) pipeline.hgetall(this.dayKey("calls", day));
    for (const day of dayList) pipeline.hgetall(this.dayKey("errors", day));
    const results = (await pipeline.exec()) ?? [];

    const summary: UsageSummary = {
      days: window,
      from: dayList[dayList.length - 1],
      to: dayList[0],
      totals: emptyCounts(),
      byTool: {},
      byUser: {},
      byDay: {},
      byToolUser: {},
    };

    const ingest = (
      day: string,
      fields: Record<string, string>,
      kind: keyof UsageCounts,
    ): void => {
      for (const [field, raw] of Object.entries(fields)) {
        const count = parseInt(raw, 10);
        if (!Number.isFinite(count)) continue;
        const [toolName, accountId = "unknown"] = field.split("|");

        summary.totals[kind] += count;
        (summary.byTool[toolName] ??= emptyCounts())[kind] += count;
        (summary.byUser[accountId] ??= emptyCounts())[kind] += count;
        (summary.byDay[day] ??= emptyCounts())[kind] += count;
        ((summary.byToolUser[toolName] ??= {})[accountId] ??= emptyCounts())[
          kind
        ] += count;
      }
    };

    for (let i = 0; i < dayList.length; i++) {
      const [callsErr, calls] = results[i] ?? [null, {}];
      const [errorsErr, errors] = results[dayList.length + i] ?? [null, {}];
      if (!callsErr && calls) {
        ingest(dayList[i], calls as Record<string, string>, "calls");
      }
      if (!errorsErr && errors) {
        ingest(dayList[i], errors as Record<string, string>, "errors");
      }
    }

    return summary;
  }
}

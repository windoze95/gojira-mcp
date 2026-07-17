import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SUMMARY_DAYS, UsageMetrics } from "../../src/metrics/usage.js";
import { makeRedis } from "../helpers/redis.js";

const FIXED_NOW = new Date("2026-07-17T12:00:00Z");
const TODAY = "2026-07-17";

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("UsageMetrics", () => {
  let redis: ReturnType<typeof makeRedis>;
  let metrics: UsageMetrics;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
    redis = makeRedis();
    metrics = new UsageMetrics(redis);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments the daily calls hash keyed by tool and account", async () => {
    metrics.record("projects.listJiraProjects", "acct-1", true);
    metrics.record("projects.listJiraProjects", "acct-1", true);
    metrics.record("projects.listJiraProjects", "acct-2", true);
    await flushAsync();

    const fields = await redis.hgetall(`metrics:calls:${TODAY}`);
    expect(fields).toEqual({
      "projects.listJiraProjects|acct-1": "2",
      "projects.listJiraProjects|acct-2": "1",
    });

    const ttl = await redis.ttl(`metrics:calls:${TODAY}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400 * 86400);
  });

  it("uses the errors hash for failed calls and strips the field separator", async () => {
    metrics.record("weird|tool", "acct|1", false);
    await flushAsync();

    const fields = await redis.hgetall(`metrics:errors:${TODAY}`);
    expect(fields).toEqual({ "weird_tool|acct_1": "1" });
  });

  it("swallows redis failures without throwing", async () => {
    const failing = {
      multi: () => {
        throw new Error("redis down");
      },
    };
    const m = new UsageMetrics(failing as never);

    expect(() => m.record("t", "acct-1", true)).not.toThrow();
    await flushAsync();
  });

  it("aggregates recorded usage into a summary", async () => {
    metrics.record("projects.listJiraProjects", "acct-1", true);
    metrics.record("projects.listJiraProjects", "acct-1", true);
    metrics.record("issues.createJiraIssue", "acct-2", true);
    metrics.record("issues.createJiraIssue", "acct-2", false);
    await flushAsync();

    const summary = await metrics.summary(7);

    expect(summary.days).toBe(7);
    expect(summary.to).toBe(TODAY);
    expect(summary.totals).toEqual({ calls: 3, errors: 1 });
    expect(summary.byTool).toEqual({
      "projects.listJiraProjects": { calls: 2, errors: 0 },
      "issues.createJiraIssue": { calls: 1, errors: 1 },
    });
    expect(summary.byUser).toEqual({
      "acct-1": { calls: 2, errors: 0 },
      "acct-2": { calls: 1, errors: 1 },
    });
    expect(summary.byDay[TODAY]).toEqual({ calls: 3, errors: 1 });
    expect(summary.byToolUser["issues.createJiraIssue"]["acct-2"]).toEqual({
      calls: 1,
      errors: 1,
    });
  });

  it("caps the window at MAX_SUMMARY_DAYS and floors it at 1", async () => {
    const capped = await metrics.summary(9999);
    expect(capped.days).toBe(MAX_SUMMARY_DAYS);

    const floored = await metrics.summary(-3);
    expect(floored.days).toBe(1);
    expect(floored.totals).toEqual({ calls: 0, errors: 0 });
  });
});

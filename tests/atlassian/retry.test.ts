import { describe, expect, it } from "vitest";
import { withRetry } from "../../src/atlassian/retry.js";
import { AtlassianApiError } from "../../src/atlassian/errors.js";

function apiError(status: number, retryAfterMs: number | null = null): AtlassianApiError {
  return new AtlassianApiError(status, { message: "x" }, `status ${status}`, retryAfterMs, false, null, "GET /x");
}

const fastOpts = { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 2, backoffMultiplier: 2 };

function countingOp(err: unknown): { run: () => Promise<never>; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      throw err;
    },
    calls: () => calls,
  };
}

describe("withRetry — idempotency-aware retry", () => {
  it("retries idempotent ops on 500", async () => {
    const op = countingOp(apiError(500));
    await expect(withRetry(op.run, fastOpts, { idempotent: true })).rejects.toThrow();
    expect(op.calls()).toBe(4); // initial + 3 retries
  });

  it("does NOT retry non-idempotent ops on 500 (duplicate-write guard)", async () => {
    const op = countingOp(apiError(500));
    await expect(withRetry(op.run, fastOpts, { idempotent: false })).rejects.toThrow();
    expect(op.calls()).toBe(1);
  });

  it("retries 429 even for non-idempotent ops (rejected before processing)", async () => {
    const op = countingOp(apiError(429));
    await expect(withRetry(op.run, fastOpts, { idempotent: false })).rejects.toThrow();
    expect(op.calls()).toBe(4);
  });

  it("does NOT retry non-idempotent ops on an ambiguous timeout", async () => {
    const op = countingOp(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    await expect(withRetry(op.run, fastOpts, { idempotent: false })).rejects.toThrow();
    expect(op.calls()).toBe(1);
  });

  it("retries non-idempotent ops on a pre-send connection refusal (never reached server)", async () => {
    const op = countingOp(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(withRetry(op.run, fastOpts, { idempotent: false })).rejects.toThrow();
    expect(op.calls()).toBe(4);
  });

  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw apiError(503);
        return "ok";
      },
      fastOpts,
      { idempotent: true },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

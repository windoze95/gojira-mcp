import { describe, expect, it, beforeEach } from "vitest";
import { RateLimiter } from "../../src/middleware/rateLimiter.js";
import { makeRedis } from "../helpers/redis.js";

describe("RateLimiter (D6 extensions)", () => {
  let redis: ReturnType<typeof makeRedis>;
  let limiter: RateLimiter;

  beforeEach(() => {
    redis = makeRedis();
    limiter = new RateLimiter(redis, { capacity: 5, windowSec: 60 });
  });

  it("allows up to capacity then denies", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await limiter.checkLimit("u");
      expect(r.allowed).toBe(true);
    }
    const denied = await limiter.checkLimit("u");
    expect(denied.allowed).toBe(false);
  });

  it("extra_deduct (NearLimit feedback) burns extra tokens", async () => {
    // Spend 1 token first, then deduct 4 via feedback — bucket should be empty.
    await limiter.checkLimit("u");
    await limiter.applyFeedback("u", { extraDeduct: 4 });
    const denied = await limiter.checkLimit("u");
    expect(denied.allowed).toBe(false);
  });

  it("reset_floor_until soft-caps the bucket", async () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    await limiter.applyFeedback("u", { resetFloorUntilUnix: future });
    // Capacity is 5; soft cap = max(1, floor(5/4)) = 1
    const r = await limiter.checkLimit("u");
    expect(r.allowed).toBe(true);
    expect(r.softCapped).toBe(true);
    expect(r.effectiveCapacity).toBeLessThan(5);
  });
});

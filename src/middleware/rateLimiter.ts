import type { RedisType } from "../redis/client.js";
import { logger } from "../utils/logger.js";

/**
 * Atomic token-bucket Lua script.
 *
 * KEYS[1] = bucket key
 * ARGV: now_ms, capacity, refill_per_sec, window_sec, extra_deduct, reset_floor_until_ms
 *
 * Behaviour:
 *   - Refill at `refill_per_sec` per second since last_refill, capped at capacity.
 *   - Apply `extra_deduct` (D6) before testing for spend (still requires 1 free token).
 *   - If `reset_floor_until_ms` is in the future, cap the bucket at `floor` value
 *     (here we use `max(1, capacity / 4)` — soft cap until reset). This matches
 *     the spec's intent: when Atlassian signals a future reset, we conserve.
 *   - Returns: { allowed (0|1), tokens_after, capacity, soft_capped (0|1) }
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_per_sec = tonumber(ARGV[3])
local window_sec = tonumber(ARGV[4])
local extra_deduct = tonumber(ARGV[5])
local reset_floor_until_ms = tonumber(ARGV[6])

local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms', 'reset_floor_until_ms')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
local existing_floor = tonumber(data[3])

if tokens == nil then
  tokens = capacity
end
if last == nil then
  last = now_ms
end

local elapsed_ms = now_ms - last
if elapsed_ms < 0 then elapsed_ms = 0 end
local refill = (elapsed_ms / 1000.0) * refill_per_sec
tokens = math.min(capacity, tokens + refill)

-- merge incoming floor with existing
local floor_until = 0
if existing_floor ~= nil and existing_floor > now_ms then floor_until = existing_floor end
if reset_floor_until_ms ~= nil and reset_floor_until_ms > floor_until then
  floor_until = reset_floor_until_ms
end

local soft_capped = 0
local effective_cap = capacity
if floor_until > now_ms then
  effective_cap = math.max(1, math.floor(capacity / 4))
  if tokens > effective_cap then tokens = effective_cap end
  soft_capped = 1
end

-- additional deduction signaled by caller (D6 NearLimit)
if extra_deduct ~= nil and extra_deduct > 0 then
  tokens = tokens - extra_deduct
  if tokens < 0 then tokens = 0 end
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'last_refill_ms', now_ms, 'reset_floor_until_ms', floor_until)
redis.call('EXPIRE', key, window_sec * 2)
return { allowed, tostring(tokens), tostring(effective_cap), soft_capped }
`;

export interface RateLimitConfig {
  /** Bucket capacity (tokens). Mirrors RATE_LIMIT_PER_USER. */
  capacity: number;
  /** Window (seconds) over which capacity refills linearly. */
  windowSec: number;
}

export interface DeductOpts {
  /** Additional tokens to subtract (D6 — supplied after a near-limit response). */
  extraDeduct?: number;
  /** Unix-seconds reset timestamp — cap the bucket softly until then. */
  resetFloorUntilUnix?: number | null;
}

export interface BucketResult {
  allowed: boolean;
  tokens: number;
  effectiveCapacity: number;
  softCapped: boolean;
}

export class RateLimiter {
  constructor(
    private readonly redis: RedisType,
    private readonly cfg: RateLimitConfig,
  ) {}

  async checkLimit(accountId: string, opts: DeductOpts = {}): Promise<BucketResult> {
    const key = `ratelimit:${accountId}`;
    const refillPerSec = this.cfg.capacity / this.cfg.windowSec;
    const floorMs =
      opts.resetFloorUntilUnix && opts.resetFloorUntilUnix > 0
        ? opts.resetFloorUntilUnix * 1000
        : 0;
    try {
      const res = (await this.redis.eval(
        BUCKET_SCRIPT,
        1,
        key,
        Date.now().toString(),
        this.cfg.capacity.toString(),
        refillPerSec.toString(),
        this.cfg.windowSec.toString(),
        (opts.extraDeduct ?? 0).toString(),
        floorMs.toString(),
      )) as [number, string, string, number];
      return {
        allowed: res[0] === 1,
        tokens: Number(res[1]),
        effectiveCapacity: Number(res[2]),
        softCapped: res[3] === 1,
      };
    } catch (err) {
      // fail-open
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), accountId },
        "RateLimiter fail-open due to Redis error",
      );
      return { allowed: true, tokens: this.cfg.capacity, effectiveCapacity: this.cfg.capacity, softCapped: false };
    }
  }

  /** Apply post-call signals from upstream headers (D6) without consuming a token. */
  async applyFeedback(accountId: string, opts: DeductOpts): Promise<void> {
    if (!opts.extraDeduct && !opts.resetFloorUntilUnix) return;
    const key = `ratelimit:${accountId}`;
    try {
      // Use the same script with a zero-spend semantics by deducting and crediting back.
      // Simpler: read-modify-write under a brief WATCH/MULTI. We use a tiny Lua to keep it atomic.
      const FEEDBACK_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local extra_deduct = tonumber(ARGV[2])
local reset_floor_until_ms = tonumber(ARGV[3])
local window_sec = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms', 'reset_floor_until_ms')
local tokens = tonumber(data[1])
local last = tonumber(data[2])
local existing_floor = tonumber(data[3]) or 0
local needs_init = 0
if tokens == nil then needs_init = 1 end
if reset_floor_until_ms ~= nil and reset_floor_until_ms > existing_floor then
  existing_floor = reset_floor_until_ms
end
if needs_init == 1 then
  -- Don't touch tokens (let the next checkLimit initialise to capacity).
  redis.call('HSET', key, 'reset_floor_until_ms', existing_floor)
  if last == nil then redis.call('HSET', key, 'last_refill_ms', now_ms) end
  -- This branch CREATES the key, so it must expire it like checkLimit does —
  -- otherwise every account that only ever gets feedback leaks a TTL-less key.
  redis.call('EXPIRE', key, window_sec * 2)
  return 1
end
if extra_deduct ~= nil and extra_deduct > 0 then
  tokens = tokens - extra_deduct
  if tokens < 0 then tokens = 0 end
end
redis.call('HSET', key, 'tokens', tokens, 'reset_floor_until_ms', existing_floor)
redis.call('EXPIRE', key, window_sec * 2)
return 1
`;
      const floorMs =
        opts.resetFloorUntilUnix && opts.resetFloorUntilUnix > 0
          ? opts.resetFloorUntilUnix * 1000
          : 0;
      await this.redis.eval(
        FEEDBACK_SCRIPT,
        1,
        key,
        Date.now().toString(),
        (opts.extraDeduct ?? 0).toString(),
        floorMs.toString(),
        this.cfg.windowSec.toString(),
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), accountId },
        "RateLimiter feedback ignored (Redis error)",
      );
    }
  }
}

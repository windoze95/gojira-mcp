# Rate limiting

Per-user token-bucket implemented atomically in Redis via a Lua script.
Fail-open: if Redis is unreachable, the limiter returns `allowed=true`
and emits a warn-level log — availability for non-security failures.

## Bucket parameters

| | |
|---|---|
| Key | `ratelimit:<accountId>` (Redis hash) |
| Fields | `tokens`, `last_refill_ms`, `reset_floor_until_ms` |
| Capacity | `RATE_LIMIT_PER_USER` (default 60) |
| Window | 60 seconds, linear refill at `capacity / 60` tokens per second |
| Per-key TTL | `window * 2` (120s) to garbage-collect idle buckets |

## Algorithm

The Lua script does refill, soft-cap, optional extra-deduction, and spend
in a single atomic step:

1. Read `tokens`, `last_refill_ms`, `reset_floor_until_ms`.
2. If `tokens` is unset, initialize to `capacity`.
3. Refill: `tokens += (elapsed_ms / 1000) * refill_per_sec`, capped at
   `capacity`.
4. If a `reset_floor_until_ms` is in the future, set `effective_cap =
   max(1, floor(capacity / 4))` and clamp `tokens` to that — soft cap until
   the reset window passes.
5. Deduct `extra_deduct` (zero on a normal call). Clamp at 0.
6. If `tokens >= 1`: decrement, return `allowed=1`.
7. `HSET` the new state, refresh TTL, return
   `[allowed, tokens, effective_cap, soft_capped]`.

## Upstream-header feedback

After every Atlassian call, the AtlassianClient inspects:

- `X-RateLimit-NearLimit: true` — the upstream bucket is nearly drained.
- `X-RateLimit-Reset` — Unix seconds (or ms) when the upstream window
  resets.
- `Retry-After` — handled by `withRetry` in the retry layer.

`onCallMeta` invokes `rateLimiter.applyFeedback(accountId, { extraDeduct,
resetFloorUntilUnix })` after each call:

- `extraDeduct` defaults to `GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT` (default 5)
  when `nearLimit=true`. This pre-emptively slows the caller before
  Atlassian starts 429-ing us.
- `resetFloorUntilUnix` activates the soft-cap behaviour described above.

Feedback never blocks the current call — it only changes the bucket state
for the next call.

## Failure modes

| Scenario | Result |
|---|---|
| Redis unreachable | Limiter logs `warn`, returns `allowed=true`, `tokens=capacity`. |
| Script bug | Same — the `try`/`catch` returns fail-open. |
| Concurrent calls for same user | Lua is atomic; impossible to double-spend. |
| Bucket starves | Tool dispatch throws `RateLimitedError` (code `RATE_LIMITED`). |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_PER_USER` | 60 | bucket capacity in requests per 60s |
| `GOJIRA_NEAR_LIMIT_EXTRA_DEDUCT` | 5 | tokens to burn when Atlassian signals NearLimit |

## Operational queries

```bash
# inspect a user's bucket
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
  HGETALL ratelimit:<accountId>

# reset (forces re-init on next call):
docker exec gojira-redis redis-cli -a "$REDIS_PASSWORD" \
  DEL ratelimit:<accountId>
```

## See also

- [Retry behaviour](../architecture/overview.md) (`withRetry` in
  `src/atlassian/retry.ts`)
- [Error model](error-model.md) — `RATE_LIMITED` envelope shape

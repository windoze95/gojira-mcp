import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

/**
 * Returns an in-memory ioredis-compatible client for tests.
 *
 * ioredis-mock shares in-memory state across instances by default. We flush
 * each new client so beforeEach() gets a guaranteed-empty bucket.
 */
export function makeRedis(): Redis {
  const r = new (RedisMock as unknown as new () => Redis)();
  // Best-effort wipe — synchronous on the mock.
  void r.flushall();
  return r;
}

import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import { logger } from "../utils/logger.js";

export function createRedisClient(url: string): RedisType {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 200, 3000);
      return delay;
    },
    reconnectOnError: (err) => {
      const msg = err.message;
      logger.warn({ err: msg }, "Redis reconnect on error");
      return /READONLY|ECONNRESET|ETIMEDOUT/.test(msg);
    },
  });

  client.on("error", (err) => {
    logger.error({ err: err.message }, "Redis client error");
  });
  client.on("connect", () => {
    logger.info("Redis client connected");
  });
  client.on("ready", () => {
    logger.info("Redis client ready");
  });
  client.on("end", () => {
    logger.warn("Redis client connection ended");
  });

  return client;
}

export type { RedisType };

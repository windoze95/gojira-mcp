import { AtlassianApiError } from "./errors.js";
import { logger } from "../utils/logger.js";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"]);

export async function withRetry<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const initial = opts.initialDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  const mult = opts.backoffMultiplier ?? 2;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      if (!retryable || attempt === maxRetries) throw err;
      const delay = computeDelay(err, attempt, initial, max, mult);
      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          status: err instanceof AtlassianApiError ? err.statusCode : undefined,
        },
        "Retrying upstream call",
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof AtlassianApiError) {
    return RETRYABLE_STATUS.has(err.statusCode);
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && RETRYABLE_NETWORK.has(code)) return true;
  }
  return false;
}

function computeDelay(
  err: unknown,
  attempt: number,
  initial: number,
  max: number,
  mult: number,
): number {
  const base = Math.min(initial * Math.pow(mult, attempt), max);
  const jitter = base * Math.random() * 0.2; // 0..20%
  let delay = base + jitter;
  if (err instanceof AtlassianApiError && err.retryAfterMs && err.retryAfterMs > delay) {
    delay = err.retryAfterMs;
  }
  return Math.min(delay, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import { AtlassianApiError } from "./errors.js";
import { logger } from "../utils/logger.js";

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

export interface RetryContext {
  /**
   * Whether the operation is safe to retry after an ambiguous failure (a
   * timeout or 5xx where the request may already have been applied upstream).
   * GET/PUT/DELETE/HEAD/OPTIONS are idempotent; POST/PATCH are not.
   */
  idempotent: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Transport failures where the request may or may not have reached the server.
const RETRYABLE_NETWORK = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);
// Failures that occur before the request is sent (connection never established
// / DNS), so retrying is safe even for non-idempotent writes.
const PRESEND_NETWORK = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
// Honor an upstream Retry-After up to this ceiling. Below the backoff cap we'd
// retry before the rate window resets — a guaranteed second 429 that burns quota.
const RETRY_AFTER_CEILING_MS = 60_000;

export async function withRetry<T>(
  op: () => Promise<T>,
  opts: RetryOptions = {},
  ctx: RetryContext = { idempotent: true },
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
      const retryable = isRetryable(err, ctx.idempotent);
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

function isRetryable(err: unknown, idempotent: boolean): boolean {
  if (err instanceof AtlassianApiError) {
    // 429 is always safe: the request was rejected before processing.
    if (err.statusCode === 429) return true;
    // 5xx is ambiguous for writes — the mutation may have been applied.
    if (!idempotent) return false;
    return RETRYABLE_STATUS.has(err.statusCode);
  }
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code !== "string") return false;
    if (idempotent) return RETRYABLE_NETWORK.has(code);
    // Non-idempotent: only retry when we know the request never reached the server.
    return PRESEND_NETWORK.has(code);
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
  const backoff = Math.min(base + jitter, max);
  // If the server told us how long to wait, honor it even past the backoff cap
  // (bounded by a ceiling) — clamping below it guarantees an immediate re-429.
  if (err instanceof AtlassianApiError && err.retryAfterMs && err.retryAfterMs > backoff) {
    return Math.min(err.retryAfterMs, RETRY_AFTER_CEILING_MS);
  }
  return backoff;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

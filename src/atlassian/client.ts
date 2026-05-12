import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import { AtlassianApiError } from "./errors.js";
import { logger } from "../utils/logger.js";
import { withRetry, type RetryOptions } from "./retry.js";

const ATLASSIAN_API_HOST = "https://api.atlassian.com";

export interface AtlassianRequestMeta {
  /** Indicates whether headers signal the bucket is nearly drained. */
  nearLimit: boolean;
  /** Unix-seconds reset timestamp from X-RateLimit-Reset, if parseable. */
  rateLimitResetUnix: number | null;
  /** Number of requests remaining in the window per X-RateLimit-Remaining, if present. */
  rateLimitRemaining: number | null;
}

export interface AtlassianResponse<T> {
  data: T;
  status: number;
  meta: AtlassianRequestMeta;
}

export interface AtlassianClientAuth {
  /** OAuth bearer access token, or Basic-auth API token. Exactly one must be set. */
  bearer?: string;
  apiToken?: { email: string; token: string };
}

export interface AtlassianClientOpts {
  baseURL: string;
  auth: AtlassianClientAuth;
  /** Extra request headers (e.g., X-Atlassian-Token: no-check for some endpoints). */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  retry?: RetryOptions;
  onCallMeta?: (meta: AtlassianRequestMeta, url: string) => void | Promise<void>;
}

export class AtlassianClient {
  readonly baseURL: string;
  private readonly axios: AxiosInstance;
  private readonly retry: RetryOptions;
  private readonly onCallMeta?: AtlassianClientOpts["onCallMeta"];

  constructor(opts: AtlassianClientOpts) {
    this.baseURL = opts.baseURL.replace(/\/+$/, "");
    this.retry = opts.retry ?? {};
    this.onCallMeta = opts.onCallMeta;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.extraHeaders ?? {}),
    };

    if (opts.auth.bearer) {
      headers.Authorization = `Bearer ${opts.auth.bearer}`;
    } else if (opts.auth.apiToken) {
      const basic = Buffer.from(
        `${opts.auth.apiToken.email}:${opts.auth.apiToken.token}`,
        "utf8",
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    } else {
      throw new Error("AtlassianClient: auth.bearer or auth.apiToken required");
    }

    this.axios = axios.create({
      baseURL: this.baseURL,
      headers,
      timeout: opts.timeoutMs ?? 30_000,
      validateStatus: () => true,
    });
  }

  request<T>(cfg: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return withRetry(() => this.execute<T>(cfg), this.retry);
  }

  get<T>(path: string, cfg?: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return this.request<T>({ ...cfg, method: "GET", url: path });
  }
  post<T>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return this.request<T>({ ...cfg, method: "POST", url: path, data: body });
  }
  put<T>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return this.request<T>({ ...cfg, method: "PUT", url: path, data: body });
  }
  patch<T>(path: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return this.request<T>({ ...cfg, method: "PATCH", url: path, data: body });
  }
  delete<T>(path: string, cfg?: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    return this.request<T>({ ...cfg, method: "DELETE", url: path });
  }

  private async execute<T>(cfg: AxiosRequestConfig): Promise<AtlassianResponse<T>> {
    const start = Date.now();
    let resp;
    try {
      resp = await this.axios.request<T>(cfg);
    } catch (err) {
      const e = err as AxiosError;
      logger.debug(
        {
          method: cfg.method,
          url: cfg.url,
          code: e.code,
          msg: e.message,
        },
        "Atlassian network error",
      );
      throw e;
    }
    const duration = Date.now() - start;
    const meta = parseRateMeta(resp.headers as Record<string, unknown>);
    logger.debug(
      {
        method: cfg.method,
        url: cfg.url,
        status: resp.status,
        duration,
        nearLimit: meta.nearLimit,
        remaining: meta.rateLimitRemaining,
      },
      "Atlassian call",
    );
    if (this.onCallMeta) {
      try {
        await this.onCallMeta(meta, `${cfg.method ?? "GET"} ${cfg.url}`);
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "onCallMeta hook failed");
      }
    }
    if (resp.status >= 200 && resp.status < 300) {
      return { data: resp.data as T, status: resp.status, meta };
    }
    throw toApiError(resp.status, resp.data, resp.headers, meta, `${cfg.method ?? "GET"} ${cfg.url ?? ""}`);
  }
}

function toApiError(
  status: number,
  body: unknown,
  headers: Record<string, unknown>,
  meta: AtlassianRequestMeta,
  url: string,
): AtlassianApiError {
  const retryAfterMs = parseRetryAfter(headers.retryafter ?? headers["retry-after"]);
  return new AtlassianApiError(
    status,
    body,
    `Atlassian responded ${status}`,
    retryAfterMs,
    meta.nearLimit,
    meta.rateLimitResetUnix,
    url,
  );
}

function parseRetryAfter(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000);
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const ms = t - Date.now();
    return ms > 0 ? ms : 0;
  }
  return null;
}

function parseRateMeta(headers: Record<string, unknown>): AtlassianRequestMeta {
  const get = (k: string) => {
    const lower = k.toLowerCase();
    for (const [hk, hv] of Object.entries(headers)) {
      if (hk.toLowerCase() === lower) return hv;
    }
    return undefined;
  };
  const nearLimitRaw = get("X-RateLimit-NearLimit");
  const resetRaw = get("X-RateLimit-Reset");
  const remainingRaw = get("X-RateLimit-Remaining");
  const nearLimit = String(nearLimitRaw ?? "").toLowerCase() === "true";
  let resetUnix: number | null = null;
  if (resetRaw != null) {
    const s = String(resetRaw).trim();
    const n = Number(s);
    if (Number.isFinite(n)) {
      // Could be seconds or ms; treat values >= 10^11 as ms.
      resetUnix = n >= 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    } else {
      const t = Date.parse(s);
      if (Number.isFinite(t)) resetUnix = Math.floor(t / 1000);
    }
  }
  let remaining: number | null = null;
  if (remainingRaw != null) {
    const n = Number(remainingRaw);
    if (Number.isFinite(n)) remaining = n;
  }
  return { nearLimit, rateLimitResetUnix: resetUnix, rateLimitRemaining: remaining };
}

export function jiraBase(cloudId: string): string {
  return `${ATLASSIAN_API_HOST}/ex/jira/${cloudId}`;
}
export function confluenceBase(cloudId: string): string {
  return `${ATLASSIAN_API_HOST}/ex/confluence/${cloudId}`;
}
export function assetsBase(workspaceId: string): string {
  return `${ATLASSIAN_API_HOST}/jsm/assets/workspace/${workspaceId}/v1`;
}
export function adminBase(): string {
  return `${ATLASSIAN_API_HOST}/admin/v1`;
}
export function atlassianApiBase(): string {
  return ATLASSIAN_API_HOST;
}

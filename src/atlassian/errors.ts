import {
  AuthExpiredError,
  AuthRequiredError,
  InsufficientPermissionsError,
  NotFoundError,
  RateLimitedError,
  UpstreamUnavailableError,
  ValidationError,
  ToolError,
} from "../middleware/errorHandler.js";

export class AtlassianApiError extends Error {
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly retryAfterMs: number | null;
  readonly nearLimit: boolean;
  readonly rateLimitResetUnix: number | null;
  readonly url: string | undefined;

  constructor(
    statusCode: number,
    responseBody: unknown,
    message: string,
    retryAfterMs: number | null,
    nearLimit: boolean,
    rateLimitResetUnix: number | null,
    url?: string,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.retryAfterMs = retryAfterMs;
    this.nearLimit = nearLimit;
    this.rateLimitResetUnix = rateLimitResetUnix;
    this.url = url;
  }
}

/**
 * Maps an upstream Atlassian failure into the MCP tool error model.
 *
 * Refresh handling note: this is called AFTER the refresh layer has had
 * a chance to react. A 401 here means either the upstream token is
 * truly bad or refresh wasn't applicable — both surface as AUTH_EXPIRED.
 */
export function mapAtlassianError(
  err: AtlassianApiError,
  opts?: { adminOrg?: boolean },
): ToolError {
  const body = err.responseBody;
  const adminOrg = opts?.adminOrg ?? false;

  switch (err.statusCode) {
    case 401:
      return new AuthExpiredError(
        "Atlassian rejected the credential. Re-authentication required.",
        { upstream: extractMessages(body) },
      );
    case 403: {
      const messages = extractMessages(body);
      if (adminOrg) {
        return new InsufficientPermissionsError(
          "Caller is not an organization admin, or the org-admin token lacks the required scope.",
          {
            upstream: messages,
            hint: "Ensure the caller's accountId is in GOJIRA_ORG_ADMIN_ACCOUNT_IDS and GOJIRA_ORG_ADMIN_TOKEN has org-admin scope.",
          },
        );
      }
      const flat = (messages ?? []).join(" ");
      if (/permission/i.test(flat)) {
        return new InsufficientPermissionsError(
          "Caller does not have permission for this operation.",
          { upstream: messages },
        );
      }
      return new InsufficientPermissionsError(
        "Forbidden by Atlassian.",
        { upstream: messages },
      );
    }
    case 404:
      return new NotFoundError("Resource not found in Atlassian.", {
        upstream: extractMessages(body),
        url: err.url,
      });
    case 400: {
      const fieldErrors = extractFieldErrors(body);
      return new ValidationError("Atlassian rejected the request as invalid.", {
        upstream: extractMessages(body),
        fieldErrors: fieldErrors ?? undefined,
      });
    }
    case 409:
      return new ValidationError("Conflict with current state of the resource.", {
        upstream: extractMessages(body),
        conflict: true,
      });
    case 410:
      return new NotFoundError("Resource has been removed.", { upstream: extractMessages(body) });
    case 429:
      return new RateLimitedError("Rate limited by Atlassian.", {
        retry_after_ms: err.retryAfterMs,
        reset_unix: err.rateLimitResetUnix,
      });
    default:
      if (err.statusCode >= 500 && err.statusCode <= 599) {
        return new UpstreamUnavailableError(`Atlassian returned ${err.statusCode}.`, {
          upstream: extractMessages(body),
        });
      }
      if (err.statusCode === 0 || err.statusCode === undefined) {
        return new UpstreamUnavailableError("Atlassian API unreachable.", {
          upstream: extractMessages(body),
        });
      }
      return new ToolError("UNEXPECTED_ERROR", `Unexpected Atlassian status ${err.statusCode}`, {
        upstream: extractMessages(body),
      });
  }
}

export { AuthRequiredError };

function extractMessages(body: unknown): string[] | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return [body];
  if (typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;

  // Jira: { errorMessages: string[], errors: { field: string } }
  if (Array.isArray(b.errorMessages) && b.errorMessages.length > 0) {
    return b.errorMessages.filter((s): s is string => typeof s === "string");
  }
  // Confluence v2 / admin.atlassian.com: { message: string, code?: string }
  if (typeof b.message === "string") return [b.message];
  // admin.atlassian.com: { errors: [{ title, detail }] }
  if (Array.isArray(b.errors)) {
    const out: string[] = [];
    for (const e of b.errors) {
      if (typeof e === "string") {
        out.push(e);
      } else if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        if (typeof o.detail === "string") out.push(o.detail);
        else if (typeof o.title === "string") out.push(o.title);
        else if (typeof o.message === "string") out.push(o.message);
      }
    }
    if (out.length > 0) return out;
  }
  // Some endpoints return { fault: { faultstring: "..." } }
  if (b.fault && typeof b.fault === "object") {
    const f = b.fault as Record<string, unknown>;
    if (typeof f.faultstring === "string") return [f.faultstring];
  }
  return undefined;
}

function extractFieldErrors(body: unknown): Record<string, string> | null {
  if (body == null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.errors && typeof b.errors === "object" && !Array.isArray(b.errors)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.errors as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return null;
}

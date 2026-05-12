import { describe, expect, it } from "vitest";
import { AtlassianApiError, mapAtlassianError } from "../../src/atlassian/errors.js";
import {
  AuthExpiredError,
  InsufficientPermissionsError,
  NotFoundError,
  RateLimitedError,
  UpstreamUnavailableError,
  ValidationError,
} from "../../src/middleware/errorHandler.js";

function err(
  status: number,
  body: unknown,
  extra: Partial<{ retryAfterMs: number; nearLimit: boolean; resetUnix: number }> = {},
): AtlassianApiError {
  return new AtlassianApiError(
    status,
    body,
    "upstream",
    extra.retryAfterMs ?? null,
    extra.nearLimit ?? false,
    extra.resetUnix ?? null,
  );
}

describe("mapAtlassianError (D7)", () => {
  it("401 → AUTH_EXPIRED", () => {
    expect(mapAtlassianError(err(401, { errorMessages: ["bad"] }))).toBeInstanceOf(AuthExpiredError);
  });

  it("403 generic → INSUFFICIENT_PERMISSIONS", () => {
    const e = mapAtlassianError(err(403, { errorMessages: ["You do not have permission"] }));
    expect(e).toBeInstanceOf(InsufficientPermissionsError);
  });

  it("403 with adminOrg flag → INSUFFICIENT_PERMISSIONS with org-admin hint", () => {
    const e = mapAtlassianError(err(403, { message: "no" }), { adminOrg: true }) as InsufficientPermissionsError;
    expect(e).toBeInstanceOf(InsufficientPermissionsError);
    expect(e.message).toMatch(/organization admin/i);
    const details = e.details as { hint?: string };
    expect(details.hint).toMatch(/org admin/i);
  });

  it("404 → NOT_FOUND", () => {
    expect(mapAtlassianError(err(404, { errorMessages: ["nope"] }))).toBeInstanceOf(NotFoundError);
  });

  it("400 with field errors → VALIDATION_ERROR with fieldErrors", () => {
    const e = mapAtlassianError(err(400, { errors: { name: "required" } })) as ValidationError;
    expect(e).toBeInstanceOf(ValidationError);
    const details = e.details as { fieldErrors?: Record<string, string> };
    expect(details.fieldErrors?.name).toBe("required");
  });

  it("409 → VALIDATION_ERROR with conflict marker", () => {
    const e = mapAtlassianError(err(409, { errorMessages: ["dup"] })) as ValidationError;
    expect(e).toBeInstanceOf(ValidationError);
    expect(JSON.stringify(e.details)).toContain("true");
  });

  it("429 → RATE_LIMITED carrying retry_after_ms", () => {
    const e = mapAtlassianError(err(429, null, { retryAfterMs: 1500 })) as RateLimitedError;
    expect(e).toBeInstanceOf(RateLimitedError);
    const details = e.details as { retry_after_ms?: number };
    expect(details.retry_after_ms).toBe(1500);
  });

  it("500-class → UPSTREAM_UNAVAILABLE", () => {
    expect(mapAtlassianError(err(500, "boom"))).toBeInstanceOf(UpstreamUnavailableError);
    expect(mapAtlassianError(err(503, "boom"))).toBeInstanceOf(UpstreamUnavailableError);
  });
});

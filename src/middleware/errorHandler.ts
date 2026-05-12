import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";

export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "INSUFFICIENT_PERMISSIONS"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UNEXPECTED_ERROR";

export interface ToolErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    reference_id: string;
  };
}

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly referenceId: string;

  constructor(code: ErrorCode, message: string, details?: unknown, referenceId?: string) {
    super(message);
    this.code = code;
    this.details = details;
    this.referenceId = referenceId ?? randomUUID();
  }

  toEnvelope(): ToolErrorEnvelope {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        reference_id: this.referenceId,
      },
    };
  }
}

export class AuthRequiredError extends ToolError {
  constructor(message = "Authentication required", details?: unknown) {
    super("AUTH_REQUIRED", message, details);
  }
}

export class AuthExpiredError extends ToolError {
  constructor(message = "Authentication expired; re-authentication required", details?: unknown) {
    super("AUTH_EXPIRED", message, details);
  }
}

export class InsufficientPermissionsError extends ToolError {
  constructor(message = "Insufficient permissions for this operation", details?: unknown) {
    super("INSUFFICIENT_PERMISSIONS", message, details);
  }
}

export class NotFoundError extends ToolError {
  constructor(message = "Resource not found", details?: unknown) {
    super("NOT_FOUND", message, details);
  }
}

export class ValidationError extends ToolError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details);
  }
}

export class RateLimitedError extends ToolError {
  constructor(message = "Rate limit exceeded", details?: unknown) {
    super("RATE_LIMITED", message, details);
  }
}

export class UpstreamUnavailableError extends ToolError {
  constructor(message = "Atlassian API is unavailable", details?: unknown) {
    super("UPSTREAM_UNAVAILABLE", message, details);
  }
}

export function handleToolError(err: unknown): ToolErrorEnvelope {
  if (err instanceof ToolError) {
    logger.warn(
      {
        err: err.message,
        code: err.code,
        reference_id: err.referenceId,
        details: err.details,
      },
      "Tool error",
    );
    return err.toEnvelope();
  }
  const referenceId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message, reference_id: referenceId, stack: err instanceof Error ? err.stack : undefined }, "Unexpected tool error");
  return {
    success: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: `An unexpected error occurred. Reference ID: ${referenceId}`,
      reference_id: referenceId,
    },
  };
}

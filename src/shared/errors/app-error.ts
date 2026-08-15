export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMIT_EXCEEDED"
  | "PROVIDER_ERROR"
  | "TRANSIENT_ERROR"
  | "PERMANENT_ERROR"
  | "CONFIGURATION_ERROR"
  | "DATABASE_ERROR"
  | "QUEUE_ERROR"
  | "POLICY_ERROR"
  | "INTERNAL_ERROR";

export interface AppErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/** The exact shape returned to API clients — never includes `details` or a stack trace. */
export interface PublicErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId?: string;
    readonly fieldErrors?: Record<string, string[]>;
    readonly retryAfterSeconds?: number;
  };
}

/**
 * Base for every typed domain/application error.
 *
 * `message` must always be safe to return to a client as-is. Anything that
 * must never leave the process (SQL text, connection strings, upstream
 * response bodies, etc.) belongs in `details`, which only the logger ever
 * sees — `toPublicJSON` deliberately omits it.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  /** Operational errors are expected failure modes (bad input, upstream timeout, ...).
   *  Non-operational errors indicate a bug or unexpected state. Both are safe to log,
   *  but only operational errors are generally safe to retry/recover from automatically. */
  abstract readonly isOperational: boolean;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    Error.captureStackTrace?.(this, new.target);
  }

  toPublicJSON(requestId?: string): PublicErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

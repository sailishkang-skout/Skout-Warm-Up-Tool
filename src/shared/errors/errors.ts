import { AppError, type AppErrorOptions, type PublicErrorBody } from "./app-error.js";

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR" as const;
  readonly httpStatus = 400;
  readonly isOperational = true;
  readonly fieldErrors?: Record<string, string[]>;

  constructor(
    message: string,
    options: AppErrorOptions & { fieldErrors?: Record<string, string[]> } = {},
  ) {
    super(message, options);
    if (options.fieldErrors !== undefined) {
      this.fieldErrors = options.fieldErrors;
    }
  }

  override toPublicJSON(requestId?: string): PublicErrorBody {
    const base = super.toPublicJSON(requestId);
    return this.fieldErrors
      ? { error: { ...base.error, fieldErrors: this.fieldErrors } }
      : base;
  }
}

export class AuthenticationError extends AppError {
  readonly code = "AUTHENTICATION_ERROR" as const;
  readonly httpStatus = 401;
  readonly isOperational = true;
}

export class AuthorizationError extends AppError {
  readonly code = "AUTHORIZATION_ERROR" as const;
  readonly httpStatus = 403;
  readonly isOperational = true;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly httpStatus = 404;
  readonly isOperational = true;

  constructor(resource: string, identifier?: string, options: AppErrorOptions = {}) {
    super(
      identifier ? `${resource} '${identifier}' was not found` : `${resource} was not found`,
      options,
    );
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly httpStatus = 409;
  readonly isOperational = true;
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly httpStatus = 429;
  readonly isOperational = true;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: AppErrorOptions & { retryAfterSeconds?: number } = {}) {
    super(message, options);
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  override toPublicJSON(requestId?: string): PublicErrorBody {
    const base = super.toPublicJSON(requestId);
    return this.retryAfterSeconds !== undefined
      ? { error: { ...base.error, retryAfterSeconds: this.retryAfterSeconds } }
      : base;
  }
}

/** An upstream mailbox provider (Gmail/M365/SMTP-IMAP) rejected or failed a request. */
export class ProviderError extends AppError {
  readonly code = "PROVIDER_ERROR" as const;
  readonly httpStatus = 502;
  readonly isOperational = true;
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, options: AppErrorOptions & { retryable?: boolean } = {}) {
    super(message, options);
    this.provider = provider;
    this.retryable = options.retryable ?? true;
  }
}

/** A generic retryable failure (timeout, connection reset, upstream unavailable). */
export class TransientError extends AppError {
  readonly code = "TRANSIENT_ERROR" as const;
  readonly httpStatus = 503;
  readonly isOperational = true;
}

/** A generic non-retryable failure — retrying with the same input will not help. */
export class PermanentError extends AppError {
  readonly code = "PERMANENT_ERROR" as const;
  readonly httpStatus = 422;
  readonly isOperational = true;
}

/** OAuth / provider wiring missing on this deployment — return 503 so proxies don't treat it as an unexpected 500. */
export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION_ERROR" as const;
  readonly httpStatus = 503;
  readonly isOperational = false;
}

export class DatabaseError extends AppError {
  readonly code = "DATABASE_ERROR" as const;
  readonly httpStatus = 500;
  readonly isOperational = true;

  constructor(message = "A database error occurred", options: AppErrorOptions = {}) {
    super(message, options);
  }
}

export class QueueError extends AppError {
  readonly code = "QUEUE_ERROR" as const;
  readonly httpStatus = 500;
  readonly isOperational = true;

  constructor(message = "A queue error occurred", options: AppErrorOptions = {}) {
    super(message, options);
  }
}

/** The policy engine could not evaluate or refused a decision for the current state. */
export class PolicyError extends AppError {
  readonly code = "POLICY_ERROR" as const;
  readonly httpStatus = 422;
  readonly isOperational = true;
}

/** Catch-all for unexpected/unclassified failures — never exposes the original message. */
export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR" as const;
  readonly httpStatus = 500;
  readonly isOperational = false;

  constructor(message = "An unexpected error occurred", options: AppErrorOptions = {}) {
    super(message, options);
  }
}

/**
 * An OAuth authorization-code flow failed for a reason that is not a
 * misconfigured deployment (that's `ConfigurationError`) and not the
 * provider itself rejecting an authenticated request (that's
 * `ProviderError`) — e.g. the user denied consent, the provider's callback
 * returned an error parameter, or a code exchange failed. `message` must
 * stay generic; never forward a raw OAuth `error_description` to the client
 * (see Stage 6 spec section 21) — put that in `details` instead.
 */
export class OAuthError extends AppError {
  readonly code = "OAUTH_ERROR" as const;
  readonly httpStatus = 400;
  readonly isOperational = true;
}

/**
 * The identity the provider actually authenticated does not match the
 * mailbox the tenant asked to connect (e.g. requested alice@example.com,
 * OAuth authenticated bob@example.com). This is a mandatory security
 * invariant, not a soft warning — connecting would let one party's mailbox
 * get silently attached to another party's record.
 */
export class ProviderIdentityMismatchError extends AppError {
  readonly code = "PROVIDER_IDENTITY_MISMATCH" as const;
  readonly httpStatus = 409;
  readonly isOperational = true;
}

/**
 * A stored credential could not be decrypted or authenticated — wrong/rotated
 * key, tampered ciphertext, or corrupt storage. Not operational: this
 * indicates either an infrastructure problem (lost/rotated encryption key)
 * or a genuine security event (tampering), never a normal, expected failure
 * mode a caller should just retry.
 */
export class CredentialError extends AppError {
  readonly code = "CREDENTIAL_ERROR" as const;
  readonly httpStatus = 500;
  readonly isOperational = false;

  constructor(message = "A stored credential could not be used", options: AppErrorOptions = {}) {
    super(message, options);
  }
}
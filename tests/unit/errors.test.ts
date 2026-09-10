import { describe, expect, it } from "vitest";
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  ConflictError,
  DatabaseError,
  InternalError,
  NotFoundError,
  PermanentError,
  PolicyError,
  ProviderError,
  QueueError,
  RateLimitError,
  TransientError,
  ValidationError,
  serializeError,
} from "../../src/shared/errors/index.js";

describe("AppError hierarchy", () => {
  it("gives each error type a stable code and HTTP status", () => {
    const cases: Array<[AppError, string, number]> = [
      [new ValidationError("bad input"), "VALIDATION_ERROR", 400],
      [new AuthenticationError("no credentials"), "AUTHENTICATION_ERROR", 401],
      [new AuthorizationError("forbidden"), "AUTHORIZATION_ERROR", 403],
      [new NotFoundError("Mailbox", "abc-123"), "NOT_FOUND", 404],
      [new ConflictError("already exists"), "CONFLICT", 409],
      [new RateLimitError("slow down"), "RATE_LIMIT_EXCEEDED", 429],
      [new ProviderError("gmail", "quota exceeded"), "PROVIDER_ERROR", 502],
      [new TransientError("timed out"), "TRANSIENT_ERROR", 503],
      [new PermanentError("cannot retry"), "PERMANENT_ERROR", 422],
      [new ConfigurationError("bad config"), "CONFIGURATION_ERROR", 503],
      [new DatabaseError(), "DATABASE_ERROR", 500],
      [new QueueError(), "QUEUE_ERROR", 500],
      [new PolicyError("no decision"), "POLICY_ERROR", 422],
      [new InternalError(), "INTERNAL_ERROR", 500],
    ];

    for (const [error, code, httpStatus] of cases) {
      expect(error.code).toBe(code);
      expect(error.httpStatus).toBe(httpStatus);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("builds a NotFoundError message from resource + identifier", () => {
    expect(new NotFoundError("Mailbox", "abc-123").message).toBe(
      "Mailbox 'abc-123' was not found",
    );
    expect(new NotFoundError("Mailbox").message).toBe("Mailbox was not found");
  });

  it("marks a provider error's provider and retryability", () => {
    const error = new ProviderError("gmail", "quota exceeded", { retryable: false });
    expect(error.provider).toBe("gmail");
    expect(error.retryable).toBe(false);
    expect(new ProviderError("gmail", "timeout").retryable).toBe(true);
  });

  it("never includes `details` in the public JSON body", () => {
    const error = new DatabaseError("A database error occurred", {
      details: {
        query: "SELECT * FROM mailbox_credentials",
        connectionString: "postgres://secret",
      },
    });
    const publicBody = error.toPublicJSON("req-1");
    expect(publicBody).toEqual({
      error: { code: "DATABASE_ERROR", message: "A database error occurred", requestId: "req-1" },
    });
    expect(JSON.stringify(publicBody)).not.toContain("secret");
  });

  it("omits requestId from the public body when none is given", () => {
    expect(new InternalError().toPublicJSON()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    });
  });

  it("includes fieldErrors in ValidationError's public JSON only when provided", () => {
    const withFieldErrors = new ValidationError("Invalid mailbox payload", {
      fieldErrors: { email: ["must be a valid email"] },
    });
    expect(withFieldErrors.toPublicJSON().error.fieldErrors).toEqual({
      email: ["must be a valid email"],
    });
    expect(new ValidationError("bad input").toPublicJSON().error.fieldErrors).toBeUndefined();
  });

  it("includes retryAfterSeconds in RateLimitError's public JSON only when provided", () => {
    const withRetry = new RateLimitError("too many requests", { retryAfterSeconds: 30 });
    expect(withRetry.toPublicJSON().error.retryAfterSeconds).toBe(30);
    expect(new RateLimitError("too many requests").toPublicJSON().error.retryAfterSeconds).toBeUndefined();
  });

  it("defaults DatabaseError/QueueError/InternalError to a safe generic message", () => {
    expect(new DatabaseError().message).toBe("A database error occurred");
    expect(new QueueError().message).toBe("A queue error occurred");
    expect(new InternalError().message).toBe("An unexpected error occurred");
  });

  it("marks programmer-facing errors as non-operational and expected failures as operational", () => {
    expect(new ValidationError("x").isOperational).toBe(true);
    expect(new NotFoundError("Mailbox").isOperational).toBe(true);
    expect(new ConfigurationError("x").isOperational).toBe(false);
    expect(new InternalError().isOperational).toBe(false);
  });
});

describe("serializeError", () => {
  it("captures name, message, stack, and code for an AppError", () => {
    const serialized = serializeError(new NotFoundError("Mailbox", "abc"));
    expect(serialized.name).toBe("NotFoundError");
    expect(serialized.code).toBe("NOT_FOUND");
    expect(serialized.message).toBe("Mailbox 'abc' was not found");
    expect(serialized.stack).toBeDefined();
  });

  it("omits code for a plain Error", () => {
    expect(serializeError(new Error("plain")).code).toBeUndefined();
  });

  it("captures only name/message of a cause", () => {
    const cause = new Error("connection refused");
    const serialized = serializeError(new DatabaseError("A database error occurred", { cause }));
    expect(serialized.cause).toEqual({ name: "Error", message: "connection refused" });
  });

  it("handles a non-Error thrown value without throwing itself", () => {
    expect(serializeError("just a string")).toEqual({ name: "NonError", message: "just a string" });
    expect(serializeError({ some: "object" })).toEqual({
      name: "NonError",
      message: "An unknown value was thrown",
    });
  });

  it("does not leak an AppError's internal `details` bag into the serialized form", () => {
    const error = new DatabaseError("A database error occurred", {
      details: { connectionString: "postgres://user:hunter2@host/db" },
    });
    expect(JSON.stringify(serializeError(error))).not.toContain("hunter2");
  });
});
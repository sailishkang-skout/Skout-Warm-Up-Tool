import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";
import { DatabaseError } from "../../src/shared/errors/index.js";
import { createLogger, sanitizeForLogging } from "../../src/shared/logger/index.js";

/** Synchronous in-memory pino destination — avoids stream/timing flakiness in assertions. */
function createCapturingDestination(): DestinationStream & { entries: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  return {
    write(msg: string) {
      lines.push(msg);
    },
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("emits structured JSON with service, env, and the log message", () => {
    const destination = createCapturingDestination();
    const logger = createLogger({ level: "info", serviceName: "test-service", env: "test" }, destination);

    logger.info("hello");

    const [entry] = destination.entries();
    expect(entry).toMatchObject({ service: "test-service", env: "test", msg: "hello" });
    expect(entry?.time).toBeDefined();
    expect(entry?.level).toBeDefined();
  });

  it("respects the configured log level", () => {
    const destination = createCapturingDestination();
    const logger = createLogger({ level: "warn", serviceName: "test-service", env: "test" }, destination);

    logger.info("should be suppressed");
    logger.warn("should appear");

    const entries = destination.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe("should appear");
  });

  it("redacts req.headers.authorization via pino's path-based redact", () => {
    const destination = createCapturingDestination();
    const logger = createLogger({ level: "info", serviceName: "test-service", env: "test" }, destination);

    logger.info(
      { req: { headers: { authorization: "Bearer super-secret-token" } } },
      "incoming request",
    );

    expect(JSON.stringify(destination.entries()[0])).not.toContain("super-secret-token");
  });

  it("serializes AppError instances via the err serializer without leaking `details`", () => {
    const destination = createCapturingDestination();
    const logger = createLogger({ level: "info", serviceName: "test-service", env: "test" }, destination);

    logger.error(
      { err: new DatabaseError("A database error occurred", { details: { password: "hunter2" } }) },
      "db failed",
    );

    const [entry] = destination.entries();
    expect(JSON.stringify(entry)).not.toContain("hunter2");
    expect((entry?.err as Record<string, unknown> | undefined)?.["code"]).toBe("DATABASE_ERROR");
  });
});

describe("sanitizeForLogging", () => {
  it("redacts keys matching known-sensitive patterns at any depth", () => {
    const input = {
      email: "user@example.com",
      smtp: { password: "hunter2", accessToken: "abc.def.ghi" },
      nested: { deeper: { apiKey: "sk-live-xyz" } },
    };

    const result = sanitizeForLogging(input);

    expect(result.email).toBe("user@example.com");
    expect(result.smtp.password).toBe("[REDACTED]");
    expect(result.smtp.accessToken).toBe("[REDACTED]");
    expect(result.nested.deeper.apiKey).toBe("[REDACTED]");
  });

  it("redacts the entire subtree when the container key itself looks sensitive", () => {
    // "credentials" itself matches the sensitive pattern, so the whole
    // subtree is dropped rather than selectively recursed into — the safe
    // failure direction even though `smtpHost`/`smtpPort` aren't secrets.
    const result = sanitizeForLogging({
      credentials: { smtpHost: "smtp.example.com", smtpPort: 587 },
    });
    expect(result.credentials).toBe("[REDACTED]");
  });

  it("redacts sensitive keys inside arrays", () => {
    const result = sanitizeForLogging([{ token: "secret" }, { safe: "value" }]);
    expect(result).toEqual([{ token: "[REDACTED]" }, { safe: "value" }]);
  });

  it("leaves Error instances untouched", () => {
    const error = new Error("boom");
    expect(sanitizeForLogging(error)).toBe(error);
  });

  it("passes through primitives and undefined unchanged", () => {
    expect(sanitizeForLogging("plain string")).toBe("plain string");
    expect(sanitizeForLogging(42)).toBe(42);
    expect(sanitizeForLogging(null)).toBe(null);
    expect(sanitizeForLogging(undefined)).toBeUndefined();
  });
});

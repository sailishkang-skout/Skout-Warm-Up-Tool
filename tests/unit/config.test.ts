import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config/index.js";
import { ConfigurationError } from "../../src/shared/errors/index.js";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

const validProductionEnv = {
  NODE_ENV: "production",
  PORT: "8080",
  LOG_LEVEL: "warn",
  DATABASE_URL: "postgresql://user:pass@db.internal:5432/warmup",
  REDIS_URL: "redis://redis.internal:6379",
  ENCRYPTION_KEY: "a".repeat(32),
  API_KEY_PEPPER: "b".repeat(32),
};

describe("loadConfig", () => {
  it("parses a valid production environment into a typed AppConfig", () => {
    const config = loadConfig(validProductionEnv);
    expect(config.env).toBe("production");
    expect(config.isProduction).toBe(true);
    expect(config.http.port).toBe(8080);
    expect(config.log.level).toBe("warn");
    expect(config.database.url).toBe(validProductionEnv.DATABASE_URL);
    expect(config.redis.url).toBe(validProductionEnv.REDIS_URL);
    expect(config.security.encryptionKey).toBe(validProductionEnv.ENCRYPTION_KEY);
    expect(config.security.apiKeyPepper).toBe(validProductionEnv.API_KEY_PEPPER);
  });

  it("defaults NODE_ENV, PORT, and LOG_LEVEL when unset", () => {
    const config = loadConfig({});
    expect(config.env).toBe("development");
    expect(config.http.port).toBe(3010);
    expect(config.log.level).toBe("info");
  });

  it("distinguishes development, test, and production", () => {
    expect(loadConfig({ NODE_ENV: "development" }).isDevelopment).toBe(true);
    expect(loadConfig({ NODE_ENV: "test" }).isTest).toBe(true);
    expect(loadConfig(validProductionEnv).isProduction).toBe(true);
  });

  it("applies development defaults for DATABASE_URL/REDIS_URL/ENCRYPTION_KEY/API_KEY_PEPPER when unset", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.database.url).toContain("localhost");
    expect(config.redis.url).toContain("localhost");
    expect(config.security.encryptionKey.length).toBeGreaterThanOrEqual(32);
    expect(config.security.apiKeyPepper.length).toBeGreaterThanOrEqual(32);
  });

  it("treats an empty string the same as unset, matching this repo's .env.example convention", () => {
    // The real .env ships ENCRYPTION_KEY= and API_KEY_PEPPER= blank, not omitted.
    const config = loadConfig({ NODE_ENV: "development", ENCRYPTION_KEY: "", API_KEY_PEPPER: "" });
    expect(config.security.encryptionKey).toBeTruthy();
    expect(config.security.apiKeyPepper).toBeTruthy();
  });

  it("does not apply development defaults in production", () => {
    const error = captureError(() => loadConfig({ NODE_ENV: "production" }));
    expect(error).toBeInstanceOf(ConfigurationError);
    const message = (error as ConfigurationError).message;
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_URL");
    expect(message).toContain("ENCRYPTION_KEY");
    expect(message).toContain("API_KEY_PEPPER");
  });

  it("rejects an ENCRYPTION_KEY shorter than 32 characters", () => {
    const error = captureError(() =>
      loadConfig({ ...validProductionEnv, ENCRYPTION_KEY: "too-short" }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it("rejects a malformed DATABASE_URL", () => {
    const error = captureError(() =>
      loadConfig({ ...validProductionEnv, DATABASE_URL: "mysql://not-postgres" }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it("rejects an API_KEY_PEPPER shorter than 32 characters", () => {
    const error = captureError(() =>
      loadConfig({ ...validProductionEnv, API_KEY_PEPPER: "too-short" }),
    );
    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it("never leaks the invalid value itself in the configuration error message", () => {
    const secretLookingValue = "s3cr3t-connection-value-should-not-leak";
    const error = captureError(() =>
      loadConfig({ ...validProductionEnv, DATABASE_URL: `mysql://${secretLookingValue}` }),
    );
    expect((error as ConfigurationError).message).not.toContain(secretLookingValue);
  });

  it("coerces PORT from a string env var to a number", () => {
    expect(loadConfig({ ...validProductionEnv, PORT: "9999" }).http.port).toBe(9999);
  });
});

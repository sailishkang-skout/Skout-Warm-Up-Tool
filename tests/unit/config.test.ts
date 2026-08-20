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
    expect(config.http.host).toBe("0.0.0.0");
    expect(config.http.bodyLimitBytes).toBe(1_048_576);
    expect(config.workers.warmupPollIntervalMs).toBe(30_000);
    expect(config.workers.classificationPollIntervalMs).toBe(15_000);
    expect(config.warmupNetwork.routingMode).toBe("off");
    expect(config.warmupNetwork.minHealthScore).toBe(50);
    expect(config.warmupNetwork.requireSpf).toBe(true);
    expect(config.warmupNetwork.requireDkim).toBe(true);
    expect(config.warmupNetwork.requireDmarc).toBe(true);
    expect(config.warmupPool.selectionStrategy).toBe("HEALTH_FIRST_LEAST_USED");
    expect(config.warmupPool.maxDomainSharePercent).toBe(70);
    expect(config.warmupPool.maxConsecutiveSameDomain).toBe(2);
    expect(config.warmupPool.selectionCooldownMs).toBe(0);
    expect(config.database.statementTimeoutMs).toBe(30_000);
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

  it("defaults AI classification to disabled without requiring an API key", () => {
    const config = loadConfig(validProductionEnv);
    expect(config.ai.provider).toBe("none");
    expect(config.ai.apiKey).toBeUndefined();
    expect(config.ai.timeoutMs).toBe(15_000);
    expect(config.ai.classifierVersion).toBe("conversation-classifier/v1");
    expect(config.ai.taxonomyVersion).toBe("classification-taxonomy/v1");
    expect(config.ai.supplementDeterministic).toBe(false);
    expect(config.conversations.policyVersion).toBe("conversation-policy/v1");
    expect(config.conversations.policyTaxonomyVersion).toBe("conversation-policy-taxonomy/v1");
  });

  it("requires AI_API_KEY when an AI provider is selected", () => {
    const error = captureError(() => loadConfig({ ...validProductionEnv, AI_CLASSIFICATION_PROVIDER: "openrouter" }));
    expect(error).toBeInstanceOf(ConfigurationError);
  });

  it("accepts a fully configured OpenRouter classifier", () => {
    const config = loadConfig({
      ...validProductionEnv,
      AI_CLASSIFICATION_PROVIDER: "openrouter",
      AI_API_KEY: "sk-or-test",
      AI_MODEL: "openai/gpt-4.1-mini",
    });
    expect(config.ai.provider).toBe("openrouter");
    expect(config.ai.apiKey).toBe("sk-or-test");
    expect(config.ai.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.ai.model).toBe("openai/gpt-4.1-mini");
  });
});

import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { ValidationError } from "../../src/shared/errors/index.js";

const testConfig = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Builds the real app (proving actual plugin wiring works end to end) and
 * adds two throwaway routes solely to exercise the error handler's branches.
 * These are test scaffolding registered here, not business routes added to
 * `src/app.ts` — Stage 2 does not add real API routes yet.
 */
async function buildTestApp() {
  const app = await buildApp(testConfig);

  app.get("/__test/throws-app-error", async () => {
    throw new ValidationError("bad payload", { fieldErrors: { name: ["is required"] } });
  });

  app.get("/__test/throws-unknown-error", async () => {
    throw new Error("something exploded with a secret token abc123");
  });

  return app;
}

describe("GET /health", () => {
  it("returns 200 with service identity, no database or Redis involved", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: testConfig.service.name,
      version: testConfig.service.version,
    });
    await app.close();
  });

  it("stamps a generated x-request-id and x-correlation-id on every response", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    await app.close();
  });

  it("honors an incoming x-request-id and x-correlation-id instead of generating new ones", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "client-request-id", "x-correlation-id": "client-correlation-id" },
    });

    expect(response.headers["x-request-id"]).toBe("client-request-id");
    expect(response.headers["x-correlation-id"]).toBe("client-correlation-id");
    await app.close();
  });
});

describe("error handling", () => {
  it("returns a consistent JSON shape for an unmatched route", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(response.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("maps a thrown AppError to its declared status/code/message and safe extra fields", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/__test/throws-app-error" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "bad payload",
        fieldErrors: { name: ["is required"] },
      },
    });
    await app.close();
  });

  it("maps an unclassified thrown error to a generic 500 and never echoes its message", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/__test/throws-unknown-error" });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    });
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("abc123");
    await app.close();
  });
});

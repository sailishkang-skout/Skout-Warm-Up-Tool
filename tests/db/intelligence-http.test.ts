/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the full mailbox intelligence HTTP flow through the real
 * composition root (real Postgres, real Redis) — the only thing mocked is
 * DNS itself (`node:dns/promises`), the same way oauth-http.test.ts mocks
 * the Google API rather than depending on real, uncontrolled external
 * infrastructure during a test run.
 */
import { promises as dns } from "node:dns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import type { RedisClient } from "../../src/shared/redis/index.js";
import {
  createTestDatabaseHandle,
  createTestRedisHandle,
  ensureTestDatabaseExists,
  flushTestRedis,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const testConfig = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };
const silentLogger = createLogger({ level: "silent", serviceName: testConfig.service.name, env: testConfig.env });

let handle: TestDatabaseHandle;
let redis: RedisClient;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  redis = createTestRedisHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, silentLogger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
  await flushTestRedis(redis);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (handle) await handle.database.close();
  if (redis) redis.disconnect();
});

function mockHealthyDomain() {
  vi.spyOn(dns, "resolveMx").mockResolvedValue([{ exchange: "mx1.example.com", priority: 10 }]);
  vi.spyOn(dns, "resolveTxt").mockImplementation(async (domain: string) => {
    if (domain === "_dmarc.example.com") {
      return [["v=DMARC1; p=reject"]];
    }
    if (domain === "example.com") {
      return [["v=spf1 -all"]];
    }
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  });
}

async function bootstrapTenantAndCredential(name: string) {
  const tenantRepository = new PostgresTenantRepository(handle.database);
  const credentialRepository = new PostgresApiCredentialRepository(handle.database);
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, silentLogger);
  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: testConfig.security.apiKeyPepper,
  });
  const tenant = await tenantRepository.create({ name });
  const issued = await credentialService.issueCredential(tenant.id, { name: "Test credential" });
  return { tenant, apiKey: issued.apiKey };
}

describe("mailbox intelligence HTTP endpoints", () => {
  it("GET /:id/intelligence computes and returns a full assessment, including domain signals", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Intelligence Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "alice@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mailboxId).toBe(mailboxId);
    expect(body.health).toBeDefined();
    expect(body.risk).toBeDefined();
    expect(body.eligibility).toBeDefined();
    expect(body.capacity).toBeDefined();
    expect(body.domain.mx.status).toBe("PASS");
    expect(body.domain.spf.status).toBe("PASS");
    expect(body.domain.dmarc.status).toBe("PASS");
    expect(body.domain.dmarc.policy).toBe("reject");

    await app.close();
  });

  it("a mailbox that has never completed OAuth requires review, not a fabricated ELIGIBLE", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Review Co");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "bob@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/eligibility`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.decision).not.toBe("ELIGIBLE");
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);

    await app.close();
  });

  it("GET /:id/risk and /:id/capacity return focused, consistent views of the same underlying assessment", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Focused Co");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "carol@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const risk = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/risk`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const capacity = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/capacity`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(risk.statusCode).toBe(200);
    expect(risk.json()).toHaveProperty("riskLevel");
    expect(risk.json()).toHaveProperty("riskFactors");
    expect(capacity.statusCode).toBe(200);
    expect(capacity.json()).toHaveProperty("recommendedDailyVolume");
    expect(capacity.json()).toHaveProperty("confidence");

    await app.close();
  });

  it("POST /:id/intelligence/refresh forces recomputation and is rate-limited on a second immediate call", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Refresh Co");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "dave@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence/refresh`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence/refresh`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });

    await app.close();
  });

  it("GET /:id/intelligence/history returns entries newest first and respects a bounded limit", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("History Co");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "erin@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence/history?limit=5`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().history.length).toBeGreaterThanOrEqual(1);

    const excessiveLimit = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence/history?limit=99999`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(excessiveLimit.statusCode).toBe(400);

    await app.close();
  });

  it("tenant isolation: tenant A cannot read tenant B's mailbox intelligence", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");
    const mailboxB = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${tenantB.apiKey}` },
      payload: { emailAddress: "frank@example.com", provider: "GMAIL" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxB.json().id}/intelligence`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("rejects every intelligence endpoint without authentication", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const fakeMailboxId = "00000000-0000-0000-0000-000000000000";

    for (const path of ["intelligence", "risk", "eligibility", "capacity", "intelligence/history"]) {
      const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${fakeMailboxId}/${path}` });
      expect(response.statusCode).toBe(401);
    }

    await app.close();
  });

  it("never leaks a stack trace or internal DNS error detail in a response", async () => {
    vi.spyOn(dns, "resolveMx").mockRejectedValue(Object.assign(new Error("queryMx ESERVFAIL boom.internal"), { code: "ESERVFAIL" }));
    vi.spyOn(dns, "resolveTxt").mockRejectedValue(Object.assign(new Error("queryTxt ESERVFAIL boom.internal"), { code: "ESERVFAIL" }));
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("NoLeak Co");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "grace@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/intelligence`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const text = JSON.stringify(response.json());
    expect(text).not.toContain("boom.internal");
    expect(text).not.toContain("ESERVFAIL");
    expect(text).not.toContain("stack");
    expect(response.json().domain.mx.status).toBe("ERROR");

    await app.close();
  });
});

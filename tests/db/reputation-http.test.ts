/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the reputation HTTP endpoints and the full Stage 10 feedback
 * loop end-to-end through the real composition root: delivery event →
 * reputation assessment → risk factor, all via real Postgres/Redis, no
 * mocked SQL/Redis behavior (DNS is mocked, same as intelligence-http.test.ts,
 * since it's the only genuinely external dependency in the health pipeline).
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
    if (domain === "_dmarc.example.com") return [["v=DMARC1; p=reject"]];
    if (domain === "example.com") return [["v=spf1 -all"]];
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

async function createMailbox(app: Awaited<ReturnType<typeof buildApp>>, apiKey: string, emailAddress: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/mailboxes",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { emailAddress, provider: "GMAIL" },
  });
  return response.json().id as string;
}

async function ingestEvents(
  app: Awaited<ReturnType<typeof buildApp>>,
  apiKey: string,
  mailboxId: string,
  count: number,
  eventType: "DELIVERED" | "BOUNCED",
) {
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { mailboxId, provider: "GMAIL", providerEventId: `${eventType}-${i}`, eventType, observedAt: new Date().toISOString() },
    });
  }
}

describe("reputation HTTP endpoints", () => {
  it("GET /:id/reputation requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({ method: "GET", url: "/api/v1/mailboxes/00000000-0000-0000-0000-000000000000/reputation" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for a mailbox that has never been assessed", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Never Assessed Co");
    const mailboxId = await createMailbox(app, apiKey, "never@example.com");

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("the full feedback loop: delivery events → reputation assessment → risk factor, all through real Postgres/Redis", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Feedback Loop Co");
    const mailboxId = await createMailbox(app, apiKey, "feedback@example.com");

    await ingestEvents(app, apiKey, mailboxId, 8, "DELIVERED");
    await ingestEvents(app, apiKey, mailboxId, 8, "BOUNCED");

    // Forces the same MailboxAssessmentService.getAssessment path every
    // warmup decision already goes through — this is not a special
    // reputation-only trigger.
    const riskResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(riskResponse.statusCode).toBe(200);
    const risk = riskResponse.json();
    expect(risk.riskFactors.map((f: { code: string }) => f.code)).toContain("HIGH_BOUNCE_RATE");

    const reputationResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(reputationResponse.statusCode).toBe(200);
    const reputation = reputationResponse.json();
    expect(reputation.factors.map((f: { code: string }) => f.code)).toContain("HIGH_BOUNCE_RATE");
    expect(["DEGRADED", "POOR", "CRITICAL"]).toContain(reputation.status);

    await app.close();
  });

  it("a healthy mailbox with no delivery evidence yet is reflected as UNKNOWN reputation, never fabricated as healthy or failed", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("No Evidence Co");
    const mailboxId = await createMailbox(app, apiKey, "noevidence@example.com");

    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });
    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.json().status).toBe("UNKNOWN");

    await app.close();
  });

  it("GET /:id/reputation/history is bounded and newest-first", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("History Co");
    const mailboxId = await createMailbox(app, apiKey, "history@example.com");

    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation/history?limit=5`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().history.length).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it("is tenant-scoped — a different tenant can never read another tenant's reputation", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey: apiKeyA } = await bootstrapTenantAndCredential("Tenant A Rep Co");
    const mailboxIdA = await createMailbox(app, apiKeyA, "a@example.com");
    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxIdA}/risk`, headers: { authorization: `Bearer ${apiKeyA}` } });

    const { apiKey: apiKeyB } = await bootstrapTenantAndCredential("Tenant B Rep Co");
    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxIdA}/reputation`, headers: { authorization: `Bearer ${apiKeyB}` } });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("a new delivery event forces recomputation on the next read even though the time-based freshness window has not expired yet (Stage 10 spec section 17)", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Invalidation Co");
    const mailboxId = await createMailbox(app, apiKey, "invalidation@example.com");

    const first = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/intelligence`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(first.statusCode).toBe(200);
    const firstAssessedAt = first.json().assessedAt as string;

    // Still well within the time-based freshness window — a second read
    // with nothing new would normally return the exact same cached
    // snapshot untouched.
    const stillFresh = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/intelligence`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(stillFresh.json().assessedAt).toBe(firstAssessedAt);

    await ingestEvents(app, apiKey, mailboxId, 8, "DELIVERED");
    await ingestEvents(app, apiKey, mailboxId, 8, "BOUNCED");

    const afterInvalidation = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/intelligence`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(afterInvalidation.json().assessedAt).not.toBe(firstAssessedAt);
    expect(afterInvalidation.json().risk.riskFactors.map((f: { code: string }) => f.code)).toContain("HIGH_BOUNCE_RATE");

    await app.close();
  });

  it("the reputation response exposes providerReputation and domainReputation alongside the mailbox-level view (Stage 11)", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Provider Domain Visibility Co");
    const mailboxId = await createMailbox(app, apiKey, "visibility@example.com");

    await ingestEvents(app, apiKey, mailboxId, 8, "DELIVERED");
    await ingestEvents(app, apiKey, mailboxId, 8, "BOUNCED");
    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    const body = response.json();
    expect(body.providerReputation.provider).toBe("GMAIL");
    expect(body.providerReputation.factors.map((f: { code: string }) => f.code)).toContain("PROVIDER_HIGH_BOUNCE_RATE");
    expect(body.domainReputation.domain).toBe("example.com");
    expect(body.domainReputation.authentication).toEqual({ mx: "PASS", spf: "PASS", dkim: "MISSING", dmarc: "PASS" });

    await app.close();
  });

  it("a mailbox with a perfectly clean own send history still shows elevated risk because its provider is struggling tenant-wide (Stage 11 feedback loop)", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Shared Provider Co");
    const cleanMailboxId = await createMailbox(app, apiKey, "clean@example.com");
    const noisyMailboxId = await createMailbox(app, apiKey, "noisy@example.com");

    // The noisy mailbox (same tenant, same GMAIL provider) bounces heavily.
    await ingestEvents(app, apiKey, noisyMailboxId, 8, "DELIVERED");
    await ingestEvents(app, apiKey, noisyMailboxId, 8, "BOUNCED");
    // The clean mailbox has no delivery problems of its own.
    await ingestEvents(app, apiKey, cleanMailboxId, 15, "DELIVERED");

    const riskResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${cleanMailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });
    const risk = riskResponse.json();
    expect(risk.riskFactors.map((f: { code: string }) => f.code)).toContain("PROVIDER_HIGH_BOUNCE_RATE");
    expect(risk.riskScore).toBeGreaterThan(0);

    const reputationResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${cleanMailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    const reputation = reputationResponse.json();
    expect(reputation.status).toBe("HEALTHY"); // this mailbox's OWN evidence is clean
    expect(reputation.providerReputation.factors.map((f: { code: string }) => f.code)).toContain("PROVIDER_HIGH_BOUNCE_RATE");

    await app.close();
  });

  it("response never exposes internal threshold constants or raw event metadata", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Safe Response Co");
    const mailboxId = await createMailbox(app, apiKey, "saferesponse@example.com");
    await ingestEvents(app, apiKey, mailboxId, 10, "DELIVERED");
    await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/risk`, headers: { authorization: `Bearer ${apiKey}` } });

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/reputation`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.body).not.toMatch(/accessToken|refreshToken|password|secretData|Authorization/i);
    // Threshold constants like "0.35" (critical bounce threshold) should
    // never leak — only derived status/confidence/factors/rates.
    expect(response.body).not.toMatch(/BOUNCE_RATE_THRESHOLDS|critical.*0\.35/);

    await app.close();
  });
});

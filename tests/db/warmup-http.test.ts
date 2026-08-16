/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the full warmup HTTP flow through the real composition root
 * (real Postgres, real Redis). Reaching ELIGIBLE/CONDITIONALLY_ELIGIBLE
 * through the real intelligence pipeline requires a real OAuth-connected
 * mailbox, which isn't available in a test environment — so those
 * scenarios seed a `mailbox_assessments` row directly via the same
 * repository `health` module tests already use (Stage 7's
 * `MailboxAssessmentService.getAssessment` returns a sufficiently fresh
 * existing snapshot without recomputing, so this is a legitimate way to
 * control eligibility for a test, not a mock of behavior under test).
 * There is likewise no HTTP endpoint to create a `WarmupProfile` (Stage 7
 * never built one) — profiles are seeded the same way.
 */
import { promises as dns } from "node:dns";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresMailboxAssessmentRepository } from "../../src/modules/health/infrastructure/postgres-mailbox-assessment-repository.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import type { MailboxId, TenantId } from "../../src/shared/types/index.js";
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

async function seedProfile(tenantId: TenantId, mailboxId: MailboxId) {
  return new PostgresWarmupProfileRepository(handle.database).create({
    tenantId,
    mailboxId,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
}

function baseSnapshot(overrides: Partial<Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">> = {}) {
  const now = new Date();
  return {
    health: {
      connection: "HEALTHY" as const,
      authentication: "HEALTHY" as const,
      sending: "HEALTHY" as const,
      receiving: "HEALTHY" as const,
      domain: "HEALTHY" as const,
      configuration: "HEALTHY" as const,
      assessedAt: now,
    },
    risk: { riskLevel: "LOW" as const, riskScore: 0, riskFactors: [], assessedAt: now },
    eligibility: { decision: "ELIGIBLE" as const, reasons: ["all healthy"], assessedAt: now },
    capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 5, maximumDailyVolume: 20, confidence: "HIGH" as const, reasons: ["ok"], assessedAt: now },
    assessedAt: now,
    ...overrides,
  };
}

async function seedAssessment(tenantId: TenantId, mailboxId: MailboxId, overrides: Partial<Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">> = {}) {
  return new PostgresMailboxAssessmentRepository(handle.database).create({ tenantId, mailboxId, snapshot: baseSnapshot(overrides) });
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

describe("warmup HTTP endpoints", () => {
  it("POST /:id/warmup fails with a safe policy response when no warmup profile is configured", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("No Profile Co");
    const mailboxId = await createMailbox(app, apiKey, "noprofile@example.com");

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "POLICY_ERROR" } });

    await app.close();
  });

  it("POST /:id/warmup does not activate when eligibility REQUIRES_REVIEW (never-connected mailbox, real assessment computed)", async () => {
    mockHealthyDomain();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Review Co");
    const mailboxId = await createMailbox(app, apiKey, "review@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(422);

    const status = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(status.statusCode).toBe(404); // no session was ever created

    await app.close();
  });

  it("POST /:id/warmup rejects a NOT_ELIGIBLE mailbox with a safe policy response, not a fabricated session", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("NotEligible Co");
    const mailboxId = await createMailbox(app, apiKey, "notelig@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId, {
      eligibility: { decision: "NOT_ELIGIBLE", reasons: ["Mailbox is disconnected."], assessedAt: new Date() },
    });

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "POLICY_ERROR" } });

    await app.close();
  });

  it("POST /:id/warmup activates and produces a PROCEED decision for an ELIGIBLE mailbox", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Eligible Co");
    const mailboxId = await createMailbox(app, apiKey, "eligible@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.session.state).toBe("ACTIVE");
    expect(body.decision.decision).toBe("PROCEED");
    expect(body.decision.recommendedVolume).toBeGreaterThan(0);
    expect(body.intent).toBeDefined();
    expect(body.intent.status).toBe("PENDING");

    await app.close();
  });

  it("a client cannot supply risk/eligibility/capacity/volume — POST /:id/warmup ignores any request body", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("NoInject Co");
    const mailboxId = await createMailbox(app, apiKey, "noinject@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId, { risk: { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: new Date() } });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { eligibility: "ELIGIBLE", riskLevel: "LOW", recommendedVolume: 999999 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().decision.recommendedVolume).toBeLessThan(999999);

    await app.close();
  });

  it("CONDITIONALLY_ELIGIBLE mailboxes can still start warmup, with the condition reflected in the decision", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Conditional Co");
    const mailboxId = await createMailbox(app, apiKey, "conditional@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId, {
      eligibility: { decision: "CONDITIONALLY_ELIGIBLE", reasons: ["Domain not fully configured."], assessedAt: new Date() },
      health: { connection: "HEALTHY", authentication: "HEALTHY", sending: "HEALTHY", receiving: "HEALTHY", domain: "DEGRADED", configuration: "HEALTHY", assessedAt: new Date() },
    });

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(201);
    expect(response.json().session.state).toBe("ACTIVE");

    await app.close();
  });

  it("starting warmup twice while one session is already open returns 409", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Duplicate Co");
    const mailboxId = await createMailbox(app, apiKey, "dup@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);

    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    const second = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("GET /:id/warmup reports the current session and latest decision", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Status Co");
    const mailboxId = await createMailbox(app, apiKey, "status@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().session.state).toBe("ACTIVE");
    expect(response.json().latestDecision.decision).toBe("PROCEED");

    await app.close();
  });

  it("pause -> resume round-trips through PAUSED back to ACTIVE with a fresh decision", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("PauseResume Co");
    const mailboxId = await createMailbox(app, apiKey, "pauseresume@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });

    const paused = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/pause`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().session.state).toBe("PAUSED");

    const resumed = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/resume`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().session.state).toBe("ACTIVE");
    expect(resumed.json().decision).toBeDefined();

    await app.close();
  });

  it("stop ends the session and it can no longer be paused", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Stop Co");
    const mailboxId = await createMailbox(app, apiKey, "stop@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });

    const stopped = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/stop`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().session.state).toBe("STOPPED");

    const pauseAfterStop = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/pause`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(pauseAfterStop.statusCode).toBe(404);

    // A new session can be started again after STOPPED.
    const restarted = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(restarted.statusCode).toBe(201);

    await app.close();
  });

  it("GET /:id/warmup/decisions returns history newest first, bounded by limit", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Decisions Co");
    const mailboxId = await createMailbox(app, apiKey, "decisions@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId);
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/pause`, headers: { authorization: `Bearer ${apiKey}` } });
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/resume`, headers: { authorization: `Bearer ${apiKey}` } });

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup/decisions`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().decisions.length).toBeGreaterThanOrEqual(2);

    const excessiveLimit = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/decisions?limit=99999`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(excessiveLimit.statusCode).toBe(400);

    await app.close();
  });

  it("tenant isolation: tenant A cannot see or act on tenant B's warmup session", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");
    const mailboxId = await createMailbox(app, tenantB.apiKey, "isolated@example.com");
    await seedProfile(tenantB.tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenantB.tenant.id, mailboxId as MailboxId);
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${tenantB.apiKey}` } });

    const getStatus = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${tenantA.apiKey}` } });
    expect(getStatus.statusCode).toBe(404);

    const pause = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/pause`, headers: { authorization: `Bearer ${tenantA.apiKey}` } });
    expect(pause.statusCode).toBe(404);

    await app.close();
  });

  it("rejects every warmup endpoint without authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const fakeMailboxId = "00000000-0000-0000-0000-000000000000";

    const getResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup` });
    expect(getResponse.statusCode).toBe(401);
    const postResponse = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup` });
    expect(postResponse.statusCode).toBe(401);
    for (const action of ["pause", "resume", "stop"]) {
      const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup/${action}` });
      expect(response.statusCode).toBe(401);
    }
    const decisionsResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup/decisions` });
    expect(decisionsResponse.statusCode).toBe(401);

    await app.close();
  });

  it("never leaks internal details in a rejected policy response", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("NoLeak Co");
    const mailboxId = await createMailbox(app, apiKey, "noleak@example.com");
    await seedProfile(tenant.id, mailboxId as MailboxId);
    await seedAssessment(tenant.id, mailboxId as MailboxId, {
      eligibility: { decision: "NOT_ELIGIBLE", reasons: ["Mailbox is disconnected."], assessedAt: new Date() },
    });

    const response = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup`, headers: { authorization: `Bearer ${apiKey}` } });
    const text = JSON.stringify(response.json());
    expect(text).not.toContain("stack");
    expect(text).not.toMatch(/accessToken|refreshToken|password/i);

    await app.close();
  });
});

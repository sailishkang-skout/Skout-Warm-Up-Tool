/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the reconciliation HTTP route (hardening spec Gap A) through
 * the real composition root — real Postgres, real Redis, real auth.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
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

afterEach(() => {});

afterAll(async () => {
  if (handle) await handle.database.close();
  if (redis) redis.disconnect();
});

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

async function seedSendUnknownIntent(tenantId: TenantId, mailboxId: MailboxId) {
  const profile = await new PostgresWarmupProfileRepository(handle.database).create({
    tenantId,
    mailboxId,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const session = await sessionRepository.create({ tenantId, mailboxId, profileId: profile.id });
  const decision = await new PostgresWarmupDecisionRepository(handle.database).create({
    tenantId,
    sessionId: session.id,
    mailboxId,
    warmupDay: 1,
    decision: "PROCEED",
    reasonCodes: ["RAMP_PROGRESSION"],
    reasons: ["ok"],
    recommendedVolume: 5,
    maximumVolume: 50,
    riskLevel: "LOW",
    eligibility: "ELIGIBLE",
    profileSnapshot: {
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
      active: true,
      pauseConditions: [],
    },
    generatedAt: new Date(),
  });
  const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
  await intentRepository.createIfAbsent({
    tenantId,
    sessionId: session.id,
    mailboxId,
    decisionId: decision.id,
    provider: "GMAIL",
    warmupDay: 1,
    executionSlot: 0,
    idempotencyKey: computeIdempotencyKey({ tenantId, sessionId: session.id, warmupDay: 1, executionSlot: 0 }),
    volume: 5,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const claimed = await intentRepository.claimNext("worker-1", 60_000);
  await intentRepository.markSending(tenantId, claimed!.id, "worker-1");
  return intentRepository.recordResult(tenantId, claimed!.id, "worker-1", {
    status: "SEND_UNKNOWN",
    result: { status: "SEND_UNKNOWN", provider: "GMAIL", timestamp: new Date(), retryable: false, safeReason: "Could not confirm receipt." },
  });
}

describe("warmup reconciliation HTTP endpoint", () => {
  it("POST /:id/warmup/executions/:intentId/reconcile requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/00000000-0000-0000-0000-000000000000/warmup/executions/00000000-0000-0000-0000-000000000000/reconcile`,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("moves a SEND_UNKNOWN intent to REQUIRES_RECONCILIATION and never exposes tokens/bodies", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Reconcile HTTP Co");
    const mailboxId = await createMailbox(app, apiKey, "reconcile-http@example.com");
    const unknown = await seedSendUnknownIntent(tenant.id, mailboxId as MailboxId);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/executions/${unknown.id}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("REQUIRES_RECONCILIATION");
    expect(body.intentId).toBe(unknown.id);
    const raw = response.body;
    expect(raw).not.toMatch(/accessToken|refreshToken|password|secretData|Authorization/i);

    await app.close();
  });

  it("is idempotent over HTTP — calling it twice returns 200 both times with the same status", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Reconcile Idempotent Co");
    const mailboxId = await createMailbox(app, apiKey, "reconcile-idempotent@example.com");
    const unknown = await seedSendUnknownIntent(tenant.id, mailboxId as MailboxId);

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/executions/${unknown.id}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/executions/${unknown.id}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe(first.json().status);

    await app.close();
  });

  it("rejects a mismatched mailbox id in the path with 404, even for a valid intent under the same tenant", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Reconcile Mismatch Co");
    const mailboxId = await createMailbox(app, apiKey, "reconcile-mismatch-a@example.com");
    const otherMailboxId = await createMailbox(app, apiKey, "reconcile-mismatch-b@example.com");
    const unknown = await seedSendUnknownIntent(tenant.id, mailboxId as MailboxId);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${otherMailboxId}/warmup/executions/${unknown.id}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("returns 422 for an intent that is not SEND_UNKNOWN", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Reconcile NotEligible Co");
    const mailboxId = await createMailbox(app, apiKey, "reconcile-notelig@example.com");

    const profile = await new PostgresWarmupProfileRepository(handle.database).create({
      tenantId: tenant.id,
      mailboxId: mailboxId as MailboxId,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });
    const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
    const session = await sessionRepository.create({ tenantId: tenant.id, mailboxId: mailboxId as MailboxId, profileId: profile.id });
    const decision = await new PostgresWarmupDecisionRepository(handle.database).create({
      tenantId: tenant.id,
      sessionId: session.id,
      mailboxId: mailboxId as MailboxId,
      warmupDay: 1,
      decision: "PROCEED",
      reasonCodes: ["RAMP_PROGRESSION"],
      reasons: ["ok"],
      recommendedVolume: 5,
      maximumVolume: 50,
      riskLevel: "LOW",
      eligibility: "ELIGIBLE",
      profileSnapshot: {
        targetDailyVolume: 30,
        startingDailyVolume: 5,
        maximumDailyVolume: 50,
        rampStrategy: "STANDARD",
        riskTolerance: "MEDIUM",
        active: true,
        pauseConditions: [],
      },
      generatedAt: new Date(),
    });
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const pending = await intentRepository.createIfAbsent({
      tenantId: tenant.id,
      sessionId: session.id,
      mailboxId: mailboxId as MailboxId,
      decisionId: decision.id,
      provider: "GMAIL",
      warmupDay: 1,
      executionSlot: 0,
      idempotencyKey: computeIdempotencyKey({ tenantId: tenant.id, sessionId: session.id, warmupDay: 1, executionSlot: 0 }),
      volume: 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/executions/${pending.id}/reconcile`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(422);

    await app.close();
  });
});

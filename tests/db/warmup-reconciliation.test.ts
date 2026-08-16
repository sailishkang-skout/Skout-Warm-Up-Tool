/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real reconciliation path (hardening spec Gap A) against real
 * Postgres — repository transition, service orchestration, and audit
 * recording, no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { createWarmupReconciliationService } from "../../src/modules/warmup/application/warmup-reconciliation-service.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { ConflictError, NotFoundError, PolicyError } from "../../src/shared/errors/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { asWarmupExecutionIntentId } from "../../src/shared/types/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
});

afterAll(async () => {
  if (handle) await handle.database.close();
});

async function createFixtures(emailAddress = "reconcile@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Reconcile Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress, provider: "GMAIL" });
  const profile = await new PostgresWarmupProfileRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const session = await sessionRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
  const decisionRepository = new PostgresWarmupDecisionRepository(handle.database);
  const decision = await decisionRepository.create({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
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
  return { tenant, mailbox, profile, session, decision };
}

async function createSendUnknownIntent(
  fixtures: Awaited<ReturnType<typeof createFixtures>>,
  intentRepository: PostgresWarmupExecutionIntentRepository,
  safeReason = "Could not confirm whether Gmail received the send request.",
) {
  const created = await intentRepository.createIfAbsent({
    tenantId: fixtures.tenant.id,
    sessionId: fixtures.session.id,
    mailboxId: fixtures.mailbox.id,
    decisionId: fixtures.decision.id,
    provider: "GMAIL",
    warmupDay: 1,
    executionSlot: 0,
    idempotencyKey: computeIdempotencyKey({ tenantId: fixtures.tenant.id, sessionId: fixtures.session.id, warmupDay: 1, executionSlot: 0 }),
    volume: 5,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const claimed = await intentRepository.claimNext("worker-1", 60_000);
  await intentRepository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");
  return intentRepository.recordResult(fixtures.tenant.id, claimed!.id, "worker-1", {
    status: "SEND_UNKNOWN",
    result: { status: "SEND_UNKNOWN", provider: "GMAIL", timestamp: new Date(), retryable: false, safeReason },
  });
}

describe("PostgresWarmupExecutionIntentRepository.markRequiresReconciliation", () => {
  it("transitions SEND_UNKNOWN -> REQUIRES_RECONCILIATION", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    const reconciling = await intentRepository.markRequiresReconciliation(fixtures.tenant.id, unknown.id);
    expect(reconciling.status).toBe("REQUIRES_RECONCILIATION");
  });

  it("is idempotent — calling it again on an already-REQUIRES_RECONCILIATION row returns the same status rather than erroring", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    await intentRepository.markRequiresReconciliation(fixtures.tenant.id, unknown.id);
    const second = await intentRepository.markRequiresReconciliation(fixtures.tenant.id, unknown.id);
    expect(second.status).toBe("REQUIRES_RECONCILIATION");
  });

  it("throws ConflictError for an intent that was never SEND_UNKNOWN (e.g. still PENDING)", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const pending = await intentRepository.createIfAbsent({
      tenantId: fixtures.tenant.id,
      sessionId: fixtures.session.id,
      mailboxId: fixtures.mailbox.id,
      decisionId: fixtures.decision.id,
      provider: "GMAIL",
      warmupDay: 1,
      executionSlot: 0,
      idempotencyKey: computeIdempotencyKey({ tenantId: fixtures.tenant.id, sessionId: fixtures.session.id, warmupDay: 1, executionSlot: 0 }),
      volume: 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await expect(intentRepository.markRequiresReconciliation(fixtures.tenant.id, pending.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ConflictError for a nonexistent intent id", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await expect(
      intentRepository.markRequiresReconciliation(fixtures.tenant.id, asWarmupExecutionIntentId("00000000-0000-0000-0000-000000000000")),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("WarmupReconciliationService.reconcileUnknownExecution", () => {
  it("moves a SEND_UNKNOWN intent to REQUIRES_RECONCILIATION and returns a safe result", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });
    const unknown = await createSendUnknownIntent(fixtures, intentRepository, "Could not confirm whether Gmail received the send request.");

    const result = await service.reconcileUnknownExecution(fixtures.tenant.id, unknown.id);

    expect(result.status).toBe("REQUIRES_RECONCILIATION");
    expect(result.intentId).toBe(unknown.id);
    expect(result.mailboxId).toBe(fixtures.mailbox.id);
    expect(result.safeReason).toBe("Could not confirm whether Gmail received the send request.");
  });

  it("is idempotent end-to-end — a second call returns the same result and does not double-audit", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    const first = await service.reconcileUnknownExecution(fixtures.tenant.id, unknown.id);
    const second = await service.reconcileUnknownExecution(fixtures.tenant.id, unknown.id);
    expect(second.status).toBe(first.status);

    const rows = await handle.database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM audit_events WHERE event_type = 'WARMUP_RECONCILIATION_REQUESTED' AND tenant_id = $1",
      [fixtures.tenant.id],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("records an auditable WARMUP_RECONCILIATION_REQUESTED event with safe, ID-only metadata", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    await service.reconcileUnknownExecution(fixtures.tenant.id, unknown.id);

    const rows = await handle.database.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE event_type = 'WARMUP_RECONCILIATION_REQUESTED' AND tenant_id = $1",
      [fixtures.tenant.id],
    );
    expect(rows).toHaveLength(1);
    const metadata = rows[0]?.metadata;
    expect(metadata).toMatchObject({ intentId: unknown.id, mailboxId: fixtures.mailbox.id, sessionId: fixtures.session.id, warmupDay: 1 });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password|secretData|Authorization/i);
  });

  it("is tenant-scoped — a different tenant cannot reconcile another tenant's intent", async () => {
    const fixtures = await createFixtures("a@example.com");
    const otherTenant = await new PostgresTenantRepository(handle.database).create({ name: "Other Co" });
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    await expect(service.reconcileUnknownExecution(otherTenant.id, unknown.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a nonexistent intent id", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });

    await expect(
      service.reconcileUnknownExecution(fixtures.tenant.id, asWarmupExecutionIntentId("00000000-0000-0000-0000-000000000000")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an intent that is not SEND_UNKNOWN (e.g. already SENT) — reconciliation only applies to unconfirmed sends", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });

    const created = await intentRepository.createIfAbsent({
      tenantId: fixtures.tenant.id,
      sessionId: fixtures.session.id,
      mailboxId: fixtures.mailbox.id,
      decisionId: fixtures.decision.id,
      provider: "GMAIL",
      warmupDay: 1,
      executionSlot: 0,
      idempotencyKey: computeIdempotencyKey({ tenantId: fixtures.tenant.id, sessionId: fixtures.session.id, warmupDay: 1, executionSlot: 0 }),
      volume: 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const claimed = await intentRepository.claimNext("worker-1", 60_000);
    await intentRepository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");
    const sent = await intentRepository.recordResult(fixtures.tenant.id, claimed!.id, "worker-1", {
      status: "SENT",
      result: { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false },
    });

    await expect(service.reconcileUnknownExecution(fixtures.tenant.id, sent.id)).rejects.toBeInstanceOf(PolicyError);
    expect(created.id).toBe(sent.id);
  });

  it("never calls the provider — reconciliation is purely a status transition, never a resend", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const service = createWarmupReconciliationService({ intentRepository, auditRecorder });
    const unknown = await createSendUnknownIntent(fixtures, intentRepository);

    await service.reconcileUnknownExecution(fixtures.tenant.id, unknown.id);

    // The intent's lastResult is untouched by reconciliation — still the
    // original SEND_UNKNOWN outcome, never overwritten with a new send
    // attempt's result (there was no new send attempt).
    const reloaded = await intentRepository.findById(fixtures.tenant.id, unknown.id);
    expect(reloaded?.lastResult?.status).toBe("SEND_UNKNOWN");
    expect(reloaded?.attemptCount).toBe(unknown.attemptCount);
  });
});

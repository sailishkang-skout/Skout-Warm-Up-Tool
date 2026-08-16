/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real execution worker against real Postgres repositories — only the
 * mailbox/assessment/provider-send boundaries are faked (controllable
 * in-memory doubles), the same pattern
 * tests/unit/mailbox-assessment-service.test.ts uses for MailboxService,
 * since going through real OAuth/DNS to reach a specific
 * health/risk/eligibility combination isn't practical in a test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionWorker } from "../../src/modules/warmup/application/execution-worker.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import type { Mailbox } from "../../src/modules/mailbox/domain/mailbox.js";
import type { MailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import type { ProviderCapabilities } from "../../src/modules/providers/domain/provider-capabilities.js";
import type { MailboxAssessmentService } from "../../src/modules/health/application/mailbox-assessment-service.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import type { WarmupProfileRepository } from "../../src/modules/warmup/application/warmup-profile-repository.js";
import type { WarmupProfile } from "../../src/modules/warmup/domain/warmup-profile.js";
import type { SendWarmupMessageCommand, WarmupSendProvider } from "../../src/modules/warmup/application/warmup-send-provider.js";
import type { ProviderSendResult } from "../../src/modules/warmup/domain/send-result.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import type { AuditEventRecorder } from "../../src/modules/audit/application/audit-event-recorder.js";
import { runMigrations } from "../../src/shared/db/index.js";
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

const HEALTHY: MailboxHealthAssessment = {
  connection: "HEALTHY",
  authentication: "HEALTHY",
  sending: "HEALTHY",
  receiving: "HEALTHY",
  domain: "HEALTHY",
  configuration: "HEALTHY",
  assessedAt: new Date(),
};

const SENDABLE_CAPABILITIES: ProviderCapabilities = {
  canSend: true,
  canReceive: true,
  supportsThreads: true,
  supportsFolders: false,
  supportsOAuth: true,
  supportsSmtp: false,
  supportsImap: false,
};

function fakeMailboxService(mailbox: Mailbox, capabilities: ProviderCapabilities = SENDABLE_CAPABILITIES): MailboxService {
  return {
    async createMailbox() {
      throw new Error("not used");
    },
    async getMailbox() {
      return mailbox;
    },
    async listMailboxes() {
      throw new Error("not used");
    },
    async connectMailbox() {
      throw new Error("not used");
    },
    async disconnectMailbox() {
      throw new Error("not used");
    },
    async enableMailbox() {
      throw new Error("not used");
    },
    async disableMailbox() {
      throw new Error("not used");
    },
    async getCapabilities() {
      return capabilities;
    },
    async getConnectionSnapshot() {
      throw new Error("not used");
    },
    async getConnectionHealth() {
      throw new Error("not used");
    },
    async getBaseline() {
      throw new Error("not used");
    },
  };
}

function fakeAssessmentService(getSnapshot: () => Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">): MailboxAssessmentService {
  return {
    async getAssessment(_tenantId, mailboxId) {
      const snapshot = getSnapshot();
      return { ...snapshot, id: "fake" as AssessmentSnapshot["id"], tenantId: "fake" as AssessmentSnapshot["tenantId"], mailboxId };
    },
    async refreshAssessment(_tenantId, mailboxId) {
      const snapshot = getSnapshot();
      return { ...snapshot, id: "fake" as AssessmentSnapshot["id"], tenantId: "fake" as AssessmentSnapshot["tenantId"], mailboxId };
    },
    async getHistory() {
      return [];
    },
  };
}

function fakeProfileRepository(profile: WarmupProfile): WarmupProfileRepository {
  return {
    async create() {
      throw new Error("not used");
    },
    async findByMailboxId() {
      return profile;
    },
    async update() {
      throw new Error("not used");
    },
    async setActive() {
      throw new Error("not used");
    },
  };
}

function fakeProvider(handler: (command: SendWarmupMessageCommand) => ProviderSendResult): WarmupSendProvider {
  return { async sendWarmupMessage(command) { return handler(command); } };
}

function noopAuditRecorder(): AuditEventRecorder {
  return { async record() {} };
}

function eligibleAssessment(overrides: Partial<Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">> = {}) {
  const now = new Date();
  return {
    health: HEALTHY,
    risk: { riskLevel: "LOW" as const, riskScore: 0, riskFactors: [], assessedAt: now },
    eligibility: { decision: "ELIGIBLE" as const, reasons: [], assessedAt: now },
    capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 1, maximumDailyVolume: 10, confidence: "HIGH" as const, reasons: [], assessedAt: now },
    assessedAt: now,
    ...overrides,
  };
}

async function createFixtures(emailAddress = "worker@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Worker Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress, provider: "GMAIL" });
  const profileRepository = new PostgresWarmupProfileRepository(handle.database);
  await profileRepository.create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  const profile = await profileRepository.setActive(tenant.id, mailbox.id, true);
  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const session = await sessionRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
  await sessionRepository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
  await sessionRepository.recordDailyDecision(tenant.id, session.id, 1, 10);

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
    maximumVolume: 10,
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
  const intent = await intentRepository.createIfAbsent({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
    decisionId: decision.id,
    provider: "GMAIL",
    warmupDay: 1,
    executionSlot: 0,
    idempotencyKey: computeIdempotencyKey({ tenantId: tenant.id, sessionId: session.id, warmupDay: 1, executionSlot: 0 }),
    volume: 5,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  return { tenant, mailbox, profile, session, decision, intent, sessionRepository, decisionRepository, intentRepository };
}

describe("execution worker", () => {
  it("returns undefined when nothing is claimable", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false })),
      auditRecorder: noopAuditRecorder(),
    });
    await fixtures.intentRepository.claimNext("someone-else", 60_000); // consume the only claimable intent first
    await expect(worker.processNext("worker-1")).resolves.toBeUndefined();
  });

  it("claims, passes the safety gate, calls the provider, and records SENT on ACCEPTED", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false, providerMessageId: "m-1" })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("SENT");
    expect(result?.lastResult?.providerMessageId).toBe("m-1");
  });

  it("cancels the intent instead of sending when the session is no longer ACTIVE (paused after scheduling)", async () => {
    const fixtures = await createFixtures();
    await fixtures.sessionRepository.transitionState(fixtures.tenant.id, fixtures.session.id, "ACTIVE", "PAUSED");
    let providerCalled = false;
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => {
        providerCalled = true;
        return { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false };
      }),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("CANCELLED");
    expect(providerCalled).toBe(false);
  });

  it("stale decision protection: risk turned CRITICAL since the decision was created — cancels rather than sends", async () => {
    const fixtures = await createFixtures();
    let providerCalled = false;
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(() =>
        eligibleAssessment({ risk: { riskLevel: "CRITICAL", riskScore: 90, riskFactors: [], assessedAt: new Date() } }),
      ),
      sendProvider: fakeProvider(() => {
        providerCalled = true;
        return { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false };
      }),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("CANCELLED");
    expect(providerCalled).toBe(false);
  });

  it("stale decision protection: eligibility turned NOT_ELIGIBLE since the decision was created — cancels rather than sends", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(() =>
        eligibleAssessment({ eligibility: { decision: "NOT_ELIGIBLE", reasons: ["disconnected"], assessedAt: new Date() } }),
      ),
      sendProvider: fakeProvider(() => ({ status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("CANCELLED");
  });

  it("credential/auth failure (AUTH_FAILED) is recorded as a terminal FAILED, never retried", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "AUTH_FAILED", provider: "GMAIL", timestamp: new Date(), retryable: false, safeReason: "credential rejected" })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("FAILED");
  });

  it("a temporary provider failure is re-queued to PENDING with a future scheduledFor rather than failing immediately", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "TEMPORARY_FAILURE", provider: "GMAIL", timestamp: new Date(), retryable: true })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("PENDING");
    expect(result?.scheduledFor).toBeInstanceOf(Date);
    expect(result!.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
    expect(result?.attemptCount).toBe(1);
  });

  it("retries are bounded — after enough attempts a persistently-failing intent ends up FAILED, not retried forever", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "TEMPORARY_FAILURE", provider: "GMAIL", timestamp: new Date(), retryable: true })),
      auditRecorder: noopAuditRecorder(),
    });

    // MAX_ATTEMPTS in retry-policy.ts is 5 — the 5th attempt is the one
    // that exhausts the budget and turns FAILED; a 6th call would find
    // nothing claimable at all, since FAILED is terminal.
    let last;
    for (let i = 0; i < 5; i++) {
      // Fast-forward past the backoff delay so the next processNext can reclaim immediately.
      await handle.database.query("UPDATE warmup_execution_intents SET scheduled_for = now() - interval '1 second' WHERE id = $1", [fixtures.intent.id]);
      last = await worker.processNext(`worker-${i}`);
    }
    expect(last?.status).toBe("FAILED");
    await expect(worker.processNext("worker-final")).resolves.toBeUndefined();
  });

  it("rate limiting (RATE_LIMITED) is treated as retryable, same as a temporary failure", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({ status: "RATE_LIMITED", provider: "GMAIL", timestamp: new Date(), retryable: true })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("PENDING");
  });

  it("never leaks a credential/token-shaped value into the persisted lastResult", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({
        status: "AUTH_FAILED",
        provider: "GMAIL",
        timestamp: new Date(),
        retryable: false,
        safeReason: "The stored credential was rejected.",
      })),
      auditRecorder: noopAuditRecorder(),
    });

    await worker.processNext("worker-1");
    const rows = await handle.database.query("SELECT last_result FROM warmup_execution_intents WHERE id = $1", [fixtures.intent.id]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password/i);
  });

  it("cancels rather than sends when the provider does not currently support sending (Stage 9 final safety gate)", async () => {
    const fixtures = await createFixtures();
    let providerCalled = false;
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }, { ...SENDABLE_CAPABILITIES, canSend: false }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => {
        providerCalled = true;
        return { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false };
      }),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("CANCELLED");
    expect(providerCalled).toBe(false);
  });

  it("SEND_UNKNOWN (network/timeout, receipt unconfirmed) is recorded as a distinct terminal status — never retried, never treated as FAILED", async () => {
    const fixtures = await createFixtures();
    const worker = createExecutionWorker({
      intentRepository: fixtures.intentRepository,
      sessionRepository: fixtures.sessionRepository,
      warmupProfileRepository: fakeProfileRepository(fixtures.profile),
      mailboxService: fakeMailboxService({ ...fixtures.mailbox, enabled: true }),
      mailboxAssessmentService: fakeAssessmentService(eligibleAssessment),
      sendProvider: fakeProvider(() => ({
        status: "SEND_UNKNOWN",
        provider: "GMAIL",
        timestamp: new Date(),
        retryable: false,
        safeReason: "Could not confirm whether Gmail received the send request.",
      })),
      auditRecorder: noopAuditRecorder(),
    });

    const result = await worker.processNext("worker-1");
    expect(result?.status).toBe("SEND_UNKNOWN");
    expect(result?.scheduledFor).toBeUndefined();

    // Terminal — claimNext only ever selects PENDING, so a SEND_UNKNOWN
    // intent is never reclaimed/retried by a later worker call.
    await expect(worker.processNext("worker-2")).resolves.toBeUndefined();
  });
});

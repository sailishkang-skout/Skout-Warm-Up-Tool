/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real Stage 12 scheduler (`WarmupScheduler.runTick`) against real
 * Postgres repositories — `WarmupService`, `ExecutionWorker`, and the
 * session/intent repositories are all real; only mailbox/assessment/
 * provider-send boundaries are controllable in-memory fakes, same pattern
 * as tests/db/warmup-worker.test.ts. These are the mandatory TOCTOU and
 * concurrency tests Stage 12 spec's "TOCTOU"/"CONCURRENCY" sections require.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWarmupService } from "../../src/modules/warmup/application/warmup-service.js";
import { createExecutionWorker } from "../../src/modules/warmup/application/execution-worker.js";
import { createWarmupScheduler } from "../../src/modules/warmup/application/warmup-scheduler.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import type { Mailbox } from "../../src/modules/mailbox/domain/mailbox.js";
import type { MailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import type { ProviderCapabilities } from "../../src/modules/providers/domain/provider-capabilities.js";
import type { MailboxAssessmentService } from "../../src/modules/health/application/mailbox-assessment-service.js";
import { PostgresMailboxAssessmentRepository } from "../../src/modules/health/infrastructure/postgres-mailbox-assessment-repository.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import type { RiskLevel } from "../../src/modules/risk/domain/risk-assessment.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import type { SendWarmupMessageCommand, WarmupSendProvider } from "../../src/modules/warmup/application/warmup-send-provider.js";
import type { ProviderSendResult } from "../../src/modules/warmup/domain/send-result.js";
import type { AuditEventRecorder } from "../../src/modules/audit/application/audit-event-recorder.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createTestDatabaseHandle, ensureTestDatabaseExists, resetSchema, truncateAppTables, type TestDatabaseHandle } from "./support.js";

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

function fakeMailboxService(mailbox: Mailbox): MailboxService {
  return {
    async createMailbox() { throw new Error("not used"); },
    async getMailbox() { return mailbox; },
    async listMailboxes() { throw new Error("not used"); },
    async connectMailbox() { throw new Error("not used"); },
    async disconnectMailbox() { throw new Error("not used"); },
    async enableMailbox() { throw new Error("not used"); },
    async disableMailbox() { throw new Error("not used"); },
    async getCapabilities() { return SENDABLE_CAPABILITIES; },
    async getConnectionSnapshot() { throw new Error("not used"); },
    async getConnectionHealth() { throw new Error("not used"); },
    async getBaseline() { throw new Error("not used"); },
  };
}

/**
 * A mutable-risk fake — `setRiskLevel` lets a test flip risk mid-flow to
 * exercise the TOCTOU re-check. `assessmentId`/`tenantId` on the returned
 * snapshot must be a *real* row (see `warmup_decisions.assessment_id`'s FK
 * to `mailbox_assessments`, migrations/014) — `realAssessment` is a
 * genuine row created once via `PostgresMailboxAssessmentRepository` in
 * `buildHarness`, whose id/tenantId this fake always reports even while
 * `risk.riskLevel` varies freely; only the *conclusion* needs to be
 * controllable for this test, not a second real assessment per risk level.
 */
function controllableAssessmentService(realAssessment: AssessmentSnapshot): MailboxAssessmentService & { setRiskLevel(level: RiskLevel): void } {
  let riskLevel: RiskLevel = "LOW";
  function snapshot(mailboxId: AssessmentSnapshot["mailboxId"]): AssessmentSnapshot {
    const now = new Date();
    return {
      id: realAssessment.id,
      tenantId: realAssessment.tenantId,
      mailboxId,
      health: HEALTHY,
      risk: { riskLevel, riskScore: riskLevel === "CRITICAL" ? 90 : 0, riskFactors: [], assessedAt: now },
      eligibility: { decision: "ELIGIBLE", reasons: [], assessedAt: now },
      capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 1, maximumDailyVolume: 10, confidence: "HIGH", reasons: [], assessedAt: now },
      assessedAt: now,
    };
  }
  return {
    setRiskLevel(level) { riskLevel = level; },
    async getAssessment(_tenantId, mailboxId) { return snapshot(mailboxId); },
    async refreshAssessment(_tenantId, mailboxId) { return snapshot(mailboxId); },
    async getHistory() { return []; },
  };
}

function fakeProvider(): WarmupSendProvider & { callCount: number } {
  const state = { callCount: 0 };
  return {
    get callCount() { return state.callCount; },
    async sendWarmupMessage(command: SendWarmupMessageCommand): Promise<ProviderSendResult> {
      state.callCount += 1;
      return { status: "ACCEPTED", provider: command.provider, timestamp: new Date(), retryable: false };
    },
  };
}

function noopAuditRecorder(): AuditEventRecorder {
  return { async record() {} };
}

interface Harness {
  readonly tenant: { id: import("../../src/shared/types/index.js").TenantId };
  readonly mailbox: Mailbox;
  readonly sessionRepository: PostgresWarmupSessionRepository;
  readonly intentRepository: PostgresWarmupExecutionIntentRepository;
  readonly warmupService: ReturnType<typeof createWarmupService>;
  readonly scheduler: ReturnType<typeof createWarmupScheduler>;
  readonly assessmentService: ReturnType<typeof controllableAssessmentService>;
  readonly provider: ReturnType<typeof fakeProvider>;
}

async function buildHarness(emailAddress = "scheduler@example.com", windowOverrides: { windowStartMinute?: number; windowEndMinute?: number } = {}): Promise<Harness> {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Scheduler Co" });
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
    ...windowOverrides,
  });

  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const decisionRepository = new PostgresWarmupDecisionRepository(handle.database);
  const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
  const mailboxService = fakeMailboxService(mailbox);
  const now = new Date();
  const realAssessment = await new PostgresMailboxAssessmentRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    snapshot: {
      health: HEALTHY,
      risk: { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: now },
      eligibility: { decision: "ELIGIBLE", reasons: [], assessedAt: now },
      capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 1, maximumDailyVolume: 10, confidence: "HIGH", reasons: [], assessedAt: now },
      assessedAt: now,
    },
  });
  const assessmentService = controllableAssessmentService(realAssessment);
  const auditRecorder = noopAuditRecorder();

  const warmupService = createWarmupService({
    mailboxService,
    mailboxAssessmentService: assessmentService,
    warmupProfileRepository: profileRepository,
    sessionRepository,
    decisionRepository,
    intentRepository,
    auditRecorder,
  });

  const provider = fakeProvider();
  const executionWorker = createExecutionWorker({
    intentRepository,
    sessionRepository,
    warmupProfileRepository: profileRepository,
    mailboxService,
    mailboxAssessmentService: assessmentService,
    sendProvider: provider,
    auditRecorder,
    logger,
  });

  const scheduler = createWarmupScheduler({
    warmupService,
    sessionRepository,
    intentRepository,
    executionWorker,
    auditRecorder,
    logger,
  });

  return { tenant, mailbox, sessionRepository, intentRepository, warmupService, scheduler, assessmentService, provider };
}

describe("WarmupScheduler.runTick — TOCTOU (Stage 12, mandatory)", () => {
  it("T0 healthy, T1 scheduled, T2 risk becomes CRITICAL, T3 due, T4 worker executes: NO provider send", async () => {
    const h = await buildHarness();

    // T0/T1: mailbox is healthy; starting warmup creates day 1's decision + intent.
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    expect(started.intent).toBeDefined();
    expect(started.decision?.decision).toBe("PROCEED");

    // T2: risk becomes unsafe *after* scheduling, before execution.
    h.assessmentService.setRiskLevel("CRITICAL");

    // T3/T4: the scheduler drains the now-due intent.
    const result = await h.scheduler.runTick("toctou-worker");
    expect(result.intentsProcessed).toBe(1);

    // The fresh execution-time state must win over the stale
    // scheduling-time state — the provider must never be called.
    expect(h.provider.callCount).toBe(0);
    const intent = await h.intentRepository.findById(h.tenant.id, started.intent!.id);
    expect(intent!.status).toBe("CANCELLED");
  });

  it("a mailbox that stays healthy throughout DOES reach the provider — the TOCTOU protection only blocks unsafe state, not all execution", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    expect(started.intent).toBeDefined();

    const result = await h.scheduler.runTick("toctou-worker");
    expect(result.intentsProcessed).toBe(1);
    expect(h.provider.callCount).toBe(1);
    const intent = await h.intentRepository.findById(h.tenant.id, started.intent!.id);
    expect(intent!.status).toBe("SENT");
  });

  it("T0 scheduled inside a valid window, T1 window closes, T2 due: does not execute outside the allowed window", async () => {
    // A permanently-closed window (start === end — see domain/send-window.ts)
    // deterministically represents "the window is closed by the time the
    // scheduler drains this intent," independent of wall-clock time at
    // test-run — the same technique tests/db/warmup-worker.test.ts uses.
    const h = await buildHarness("window-toctou@example.com", { windowStartMinute: 600, windowEndMinute: 600 });
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    expect(started.intent).toBeDefined();

    // Creation-time scheduling already tries to honor the window (see
    // warmup-service.ts's `nextWindowStart` call) — for a genuinely
    // never-open window that pushes `scheduledFor` out to a nonsensical
    // future instant, which would make the intent not-yet-due rather than
    // exercising this test's actual target: the execution-time re-check.
    // Forcing it due isolates exactly that (T1/T2: "the window closed by
    // the time this became due, independent of when it was scheduled").
    await handle.database.query("UPDATE warmup_execution_intents SET scheduled_for = now() - interval '1 minute' WHERE id = $1", [started.intent!.id]);

    const result = await h.scheduler.runTick("window-worker");
    expect(result.intentsProcessed).toBe(1); // claimed and processed, but deferred rather than sent
    expect(h.provider.callCount).toBe(0);
    const intent = await h.intentRepository.findById(h.tenant.id, started.intent!.id);
    expect(intent!.status).toBe("PENDING"); // re-queued, not cancelled — the day's volume is not lost
    expect(intent!.scheduledFor).toBeDefined();
  });
});

describe("WarmupScheduler.runTick — due-session advancement (Stage 12)", () => {
  it("advances an ACTIVE session to its next warmup day without simulating a pause/resume cycle", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    const day1Session = started.session;
    expect(day1Session.currentDay).toBe(1);

    // Backdate startedAt/last_decision_at so computeWarmupDay considers
    // this session's next UTC calendar day already due, without waiting
    // for real time to pass.
    await handle.database.query("UPDATE warmup_sessions SET started_at = started_at - interval '1 day', last_decision_at = last_decision_at - interval '1 day' WHERE id = $1", [day1Session.id]);

    const result = await h.scheduler.runTick("due-worker");
    expect(result.sessionsAdvanced).toBe(1);

    const advanced = await h.sessionRepository.findById(h.tenant.id, day1Session.id);
    expect(advanced!.currentDay).toBe(2);
    // Session state is unchanged (still ACTIVE) — never PAUSED/RESUMEd to get here.
    expect(advanced!.state).toBe("ACTIVE");
  });

  it("a session not yet due is left untouched", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    const result = await h.scheduler.runTick("due-worker");
    expect(result.sessionsAdvanced).toBe(0);
    const unchanged = await h.sessionRepository.findById(h.tenant.id, started.session.id);
    expect(unchanged!.currentDay).toBe(1);
  });

  it("concurrent daily evaluation for the same mailbox never creates two execution intents for the same day", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    await handle.database.query("UPDATE warmup_sessions SET started_at = started_at - interval '1 day', last_decision_at = last_decision_at - interval '1 day' WHERE id = $1", [started.session.id]);

    // Two concurrent scheduler-style calls advancing the same session to
    // the same day — the existing commitExecutionVolume CAS (not a new
    // lock) is what makes this safe; see warmup-service.ts's doc comment.
    const results = await Promise.all([
      h.warmupService.advanceDailyWarmup(h.tenant.id, h.mailbox.id),
      h.warmupService.advanceDailyWarmup(h.tenant.id, h.mailbox.id),
    ]);
    const intentsCreated = results.filter((r) => r.intent !== undefined).length;
    expect(intentsCreated).toBe(1);

    const rows = await handle.database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM warmup_execution_intents WHERE session_id = $1 AND warmup_day = 2",
      [started.session.id],
    );
    expect(rows[0]!.count).toBe("1");
  });
});

describe("WarmupScheduler.runTick — lease reclaim (Stage 12)", () => {
  it("reclaims an intent stuck in CLAIMED after a simulated worker crash, making it claimable again", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);

    // Simulate a worker crash: claim the intent, then never call recordResult.
    const claimed = await h.intentRepository.claimNext("crashed-worker", 60_000);
    expect(claimed!.id).toBe(started.intent!.id);
    // Force the lease into the past, as if 60s+ had genuinely elapsed.
    await handle.database.query("UPDATE warmup_execution_intents SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [claimed!.id]);

    const result = await h.scheduler.runTick("reclaim-worker");
    expect(result.reclaimedLeases).toBe(1);
    // The reclaimed intent should now have been claimed and processed by
    // this same tick's drain step (it's healthy, so it sends).
    expect(h.provider.callCount).toBe(1);
    const final = await h.intentRepository.findById(h.tenant.id, claimed!.id);
    expect(final!.status).toBe("SENT");
  });

  it("a persistently-crashing intent (attempt ceiling reached) is reclaimed to FAILED, not cycled forever", async () => {
    const h = await buildHarness();
    const started = await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);

    // Directly at the attempt ceiling (domain/retry-policy.ts's
    // MAX_ATTEMPTS), as if 5 real crash/reclaim cycles had already
    // happened — claimed with an already-expired lease, simulating the
    // worker that made this 5th attempt having crashed too.
    await handle.database.query(
      "UPDATE warmup_execution_intents SET attempt_count = 5, status = 'CLAIMED', lease_owner = 'crashed-worker', lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [started.intent!.id],
    );

    const reclaimed = await h.intentRepository.reclaimExpiredLeases(new Date(), 100);
    const thisIntent = reclaimed.find((r) => r.id === started.intent!.id);
    expect(thisIntent).toBeDefined();
    expect(thisIntent!.newStatus).toBe("FAILED");

    const final = await h.intentRepository.findById(h.tenant.id, started.intent!.id);
    expect(final!.status).toBe("FAILED");
  });

  it("does not reclaim a lease that has not yet expired", async () => {
    const h = await buildHarness();
    await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);
    await h.intentRepository.claimNext("live-worker", 60_000); // fresh 60s lease

    const reclaimed = await h.intentRepository.reclaimExpiredLeases(new Date(), 100);
    expect(reclaimed).toHaveLength(0);
  });
});

describe("WarmupScheduler.runTick — worker concurrency (Stage 12)", () => {
  it("two workers attempting the same intent — exactly one obtains execution ownership, the other exits without sending", async () => {
    const h = await buildHarness();
    await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);

    const [a, b] = await Promise.all([
      h.intentRepository.claimNext("worker-a", 60_000),
      h.intentRepository.claimNext("worker-b", 60_000),
    ]);
    const claimedCount = [a, b].filter((x) => x !== undefined).length;
    expect(claimedCount).toBe(1);
  });

  it("duplicate scheduler ticks running back to back never double-send the same intent", async () => {
    const h = await buildHarness();
    await h.warmupService.startWarmup(h.tenant.id, h.mailbox.id);

    await h.scheduler.runTick("tick-1");
    await h.scheduler.runTick("tick-2");
    expect(h.provider.callCount).toBe(1);
  });
});

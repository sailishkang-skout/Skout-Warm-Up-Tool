/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * real concurrent access against real Postgres — no mocked SQL, no
 * artificial serialization. Stage 8 spec section 26: "two workers claiming
 * same intent," "two requests creating same intent," "two workers
 * incrementing daily volume," "pause while worker attempts execution."
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { ConflictError } from "../../src/shared/errors/index.js";
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

async function createFixtures(emailAddress = "concurrency@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Concurrency Co" });
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
  await sessionRepository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
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
  return { tenant, mailbox, profile, session, decision, sessionRepository, decisionRepository };
}

describe("warmup concurrency", () => {
  it("duplicate concurrent intent creation never produces two rows for the same idempotency key", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    const idempotencyKey = computeIdempotencyKey({ tenantId: fixtures.tenant.id, sessionId: fixtures.session.id, warmupDay: 1, executionSlot: 0 });
    const input = {
      tenantId: fixtures.tenant.id,
      sessionId: fixtures.session.id,
      mailboxId: fixtures.mailbox.id,
      decisionId: fixtures.decision.id,
      provider: "GMAIL" as const,
      warmupDay: 1,
      executionSlot: 0,
      idempotencyKey,
      volume: 5,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => repository.createIfAbsent(input)));
    const uniqueIds = new Set(results.map((r) => r.id));
    expect(uniqueIds.size).toBe(1);

    const rows = await handle.database.query("SELECT id FROM warmup_execution_intents WHERE idempotency_key = $1", [idempotencyKey]);
    expect(rows).toHaveLength(1);
  });

  it("two concurrent workers claiming the same batch of intents never both get the same one", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);

    const intents = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        intentRepository.createIfAbsent({
          tenantId: fixtures.tenant.id,
          sessionId: fixtures.session.id,
          mailboxId: fixtures.mailbox.id,
          decisionId: fixtures.decision.id,
          provider: "GMAIL",
          warmupDay: 1,
          executionSlot: i,
          idempotencyKey: computeIdempotencyKey({ tenantId: fixtures.tenant.id, sessionId: fixtures.session.id, warmupDay: 1, executionSlot: i }),
          volume: 1,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      ),
    );
    expect(intents).toHaveLength(5);

    // 8 "workers" racing over only 5 claimable intents — some must come back empty.
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => intentRepository.claimNext(`worker-${i}`, 60_000)),
    );
    const claimedIds = claims.filter((c) => c !== undefined).map((c) => c!.id);
    expect(claimedIds).toHaveLength(5);
    expect(new Set(claimedIds).size).toBe(5); // no id claimed twice
    expect(claims.filter((c) => c === undefined)).toHaveLength(3);
  });

  it("concurrent commitExecutionVolume calls never let the daily total exceed the target", async () => {
    const fixtures = await createFixtures();
    await fixtures.sessionRepository.recordDailyDecision(fixtures.tenant.id, fixtures.session.id, 1, 10);

    // 10 concurrent attempts to commit 3 units each against a target of 10 —
    // at most 3 can succeed (9 <= 10), the 4th+ must all be refused.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fixtures.sessionRepository.commitExecutionVolume(fixtures.tenant.id, fixtures.session.id, 1, 3)),
    );
    const succeeded = results.filter((r) => r !== undefined);
    expect(succeeded.length).toBe(3);

    const final = await fixtures.sessionRepository.findOpenByMailbox(fixtures.tenant.id, fixtures.mailbox.id);
    expect(final!.committedVolumeToday).toBeLessThanOrEqual(10);
    expect(final!.committedVolumeToday).toBe(9);
  });

  it("concurrent execution-slot allocation never hands out a duplicate slot", async () => {
    const fixtures = await createFixtures();
    await fixtures.sessionRepository.recordDailyDecision(fixtures.tenant.id, fixtures.session.id, 1, 100);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => fixtures.sessionRepository.commitExecutionVolume(fixtures.tenant.id, fixtures.session.id, 1, 1)),
    );
    const slots = results.filter((r) => r !== undefined).map((r) => r!.allocatedSlot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("only one of two concurrent pause requests for the same session succeeds — the other sees a stale-state conflict", async () => {
    const fixtures = await createFixtures();

    const outcomes = await Promise.allSettled([
      fixtures.sessionRepository.transitionState(fixtures.tenant.id, fixtures.session.id, "ACTIVE", "PAUSED"),
      fixtures.sessionRepository.transitionState(fixtures.tenant.id, fixtures.session.id, "ACTIVE", "PAUSED"),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });

  it("a session paused concurrently with a claim attempt still leaves the claimed intent claimable/inspectable — the worker's own live re-check (not the claim step) is what must block execution", async () => {
    const fixtures = await createFixtures();
    const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await intentRepository.createIfAbsent({
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

    const [claimed] = await Promise.all([
      intentRepository.claimNext("worker-1", 60_000),
      fixtures.sessionRepository.transitionState(fixtures.tenant.id, fixtures.session.id, "ACTIVE", "PAUSED"),
    ]);

    expect(claimed?.status).toBe("CLAIMED");
    const session = await fixtures.sessionRepository.findById(fixtures.tenant.id, fixtures.session.id);
    expect(session?.state).toBe("PAUSED");
    // See tests/db/warmup-worker.test.ts for proof the worker's execution
    // path re-checks this live session state and cancels rather than sends.
  });
});

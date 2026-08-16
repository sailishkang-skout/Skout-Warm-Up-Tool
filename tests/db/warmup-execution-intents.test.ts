/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real execution-intent persistence layer — idempotency, claim/lease,
 * and result recording against real Postgres, no mocked SQL behavior.
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

async function createFixtures(emailAddress = "intent@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Intent Co" });
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

function intentInput(tenant: Awaited<ReturnType<typeof createFixtures>>, warmupDay = 1, executionSlot = 0) {
  return {
    tenantId: tenant.tenant.id,
    sessionId: tenant.session.id,
    mailboxId: tenant.mailbox.id,
    decisionId: tenant.decision.id,
    provider: "GMAIL" as const,
    warmupDay,
    executionSlot,
    idempotencyKey: computeIdempotencyKey({ tenantId: tenant.tenant.id, sessionId: tenant.session.id, warmupDay, executionSlot }),
    volume: 5,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
}

describe("PostgresWarmupExecutionIntentRepository", () => {
  it("creates an intent in PENDING status", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);

    const intent = await repository.createIfAbsent(intentInput(fixtures));
    expect(intent.status).toBe("PENDING");
    expect(intent.attemptCount).toBe(0);
    expect(intent.volume).toBe(5);
  });

  it("createIfAbsent is idempotent — a duplicate idempotencyKey returns the existing row, not a new one", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);

    const first = await repository.createIfAbsent(intentInput(fixtures));
    const second = await repository.createIfAbsent(intentInput(fixtures));
    expect(second.id).toBe(first.id);

    const rows = await handle.database.query("SELECT id FROM warmup_execution_intents WHERE idempotency_key = $1", [first.idempotencyKey]);
    expect(rows).toHaveLength(1);
  });

  it("claimNext atomically claims a PENDING intent and sets the lease", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));

    const claimed = await repository.claimNext("worker-1", 60_000);
    expect(claimed?.status).toBe("CLAIMED");
    expect(claimed?.leaseOwner).toBe("worker-1");
    expect(claimed?.attemptCount).toBe(1);
  });

  it("claimNext returns undefined once nothing is claimable", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    await repository.claimNext("worker-1", 60_000);

    await expect(repository.claimNext("worker-2", 60_000)).resolves.toBeUndefined();
  });

  it("claimNext ignores an intent scheduled in the future", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent({ ...intentInput(fixtures), scheduledFor: new Date(Date.now() + 60_000) });

    await expect(repository.claimNext("worker-1", 60_000)).resolves.toBeUndefined();
  });

  it("claimNext ignores an already-expired intent", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent({ ...intentInput(fixtures), expiresAt: new Date(Date.now() - 1000) });

    await expect(repository.claimNext("worker-1", 60_000)).resolves.toBeUndefined();
  });

  it("markSending transitions CLAIMED -> SENDING while the lease is held", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);

    const sending = await repository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");
    expect(sending.status).toBe("SENDING");
  });

  it("markSending throws ConflictError when the lease is no longer held by the caller", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);

    await expect(repository.markSending(fixtures.tenant.id, claimed!.id, "worker-2")).rejects.toBeInstanceOf(ConflictError);
  });

  it("recordResult sets a terminal SENT status and clears the lease", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);
    await repository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");

    const sent = await repository.recordResult(fixtures.tenant.id, claimed!.id, "worker-1", {
      status: "SENT",
      result: { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false, providerMessageId: "msg-1" },
    });
    expect(sent.status).toBe("SENT");
    expect(sent.leaseOwner).toBeUndefined();
    expect(sent.lastResult?.status).toBe("ACCEPTED");
    expect(sent.lastResult?.providerMessageId).toBe("msg-1");
  });

  it("recordResult can re-queue a retryable failure back to PENDING with a future scheduledFor", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);
    await repository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");

    const retryAt = new Date(Date.now() + 5_000);
    const requeued = await repository.recordResult(fixtures.tenant.id, claimed!.id, "worker-1", {
      status: "PENDING",
      result: { status: "TEMPORARY_FAILURE", provider: "GMAIL", timestamp: new Date(), retryable: true },
      scheduledFor: retryAt,
    });
    expect(requeued.status).toBe("PENDING");
    expect(requeued.scheduledFor?.getTime()).toBe(retryAt.getTime());
  });

  it("recordResult throws ConflictError when the lease is no longer held", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);
    await repository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");

    await expect(
      repository.recordResult(fixtures.tenant.id, claimed!.id, "worker-2", {
        status: "SENT",
        result: { status: "ACCEPTED", provider: "GMAIL", timestamp: new Date(), retryable: false },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("never persists a credential/token-shaped value in the stored result", async () => {
    const fixtures = await createFixtures();
    const repository = new PostgresWarmupExecutionIntentRepository(handle.database);
    await repository.createIfAbsent(intentInput(fixtures));
    const claimed = await repository.claimNext("worker-1", 60_000);
    await repository.markSending(fixtures.tenant.id, claimed!.id, "worker-1");
    await repository.recordResult(fixtures.tenant.id, claimed!.id, "worker-1", {
      status: "FAILED",
      result: { status: "AUTH_FAILED", provider: "GMAIL", timestamp: new Date(), retryable: false, safeReason: "Authentication rejected." },
    });

    const rows = await handle.database.query<{ last_result: unknown }>("SELECT last_result FROM warmup_execution_intents");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password|authorization/i);
  });

  it("enforces the (session, warmup_day, execution_slot) uniqueness invariant at the database level", async () => {
    const fixtures = await createFixtures();
    await handle.database.query(
      `INSERT INTO warmup_execution_intents (tenant_id, session_id, mailbox_id, decision_id, provider, warmup_day, execution_slot, idempotency_key, volume, expires_at)
       VALUES ($1, $2, $3, $4, 'GMAIL', 1, 0, 'key-a', 5, now() + interval '1 day')`,
      [fixtures.tenant.id, fixtures.session.id, fixtures.mailbox.id, fixtures.decision.id],
    );

    await expect(
      handle.database.query(
        `INSERT INTO warmup_execution_intents (tenant_id, session_id, mailbox_id, decision_id, provider, warmup_day, execution_slot, idempotency_key, volume, expires_at)
         VALUES ($1, $2, $3, $4, 'GMAIL', 1, 0, 'key-b', 5, now() + interval '1 day')`,
        [fixtures.tenant.id, fixtures.session.id, fixtures.mailbox.id, fixtures.decision.id],
      ),
    ).rejects.toThrow();
  });
});

/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real warmup-session persistence layer — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { ConflictError, NotFoundError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { asWarmupSessionId } from "../../src/shared/types/index.js";
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

async function createFixtures(emailAddress = "session@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Session Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress,
    provider: "GMAIL",
  });
  const profile = await new PostgresWarmupProfileRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  return { tenant, mailbox, profile };
}

describe("PostgresWarmupSessionRepository", () => {
  it("creates a session in DRAFT with zeroed counters", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);

    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });

    expect(session.state).toBe("DRAFT");
    expect(session.currentDay).toBe(0);
    expect(session.currentDailyTarget).toBe(0);
    expect(session.committedVolumeToday).toBe(0);
    expect(session.nextExecutionSlot).toBe(0);
    expect(session.startedAt).toBeUndefined();
  });

  it("rejects a second open session for the same mailbox (one open session per mailbox)", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });

    await expect(repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id })).rejects.toThrow();
  });

  it("allows a new session once the prior one reaches a terminal state", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const first = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, first.id, "DRAFT", "STOPPED");

    const second = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    expect(second.id).not.toBe(first.id);
  });

  it("findOpenByMailbox finds a non-terminal session and excludes terminal ones", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });

    await expect(repository.findOpenByMailbox(tenant.id, mailbox.id)).resolves.toMatchObject({ id: session.id });

    await repository.transitionState(tenant.id, session.id, "DRAFT", "STOPPED");
    await expect(repository.findOpenByMailbox(tenant.id, mailbox.id)).resolves.toBeUndefined();
  });

  it("findLatestByMailbox returns the most recent session even once terminal", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "STOPPED");

    await expect(repository.findLatestByMailbox(tenant.id, mailbox.id)).resolves.toMatchObject({ id: session.id, state: "STOPPED" });
  });

  it("transitionState sets startedAt only on the first DRAFT->ACTIVE transition", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });

    const activated = await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    expect(activated.startedAt).toBeInstanceOf(Date);

    const paused = await repository.transitionState(tenant.id, session.id, "ACTIVE", "PAUSED");
    const resumed = await repository.transitionState(tenant.id, session.id, "PAUSED", "ACTIVE");
    expect(resumed.startedAt?.getTime()).toBe(activated.startedAt?.getTime());
    expect(paused.pausedAt).toBeInstanceOf(Date);
  });

  it("transitionState throws ConflictError when the expected fromState no longer matches (concurrent change)", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");

    // Stale caller still thinks the session is DRAFT.
    await expect(repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE")).rejects.toBeInstanceOf(ConflictError);
  });

  it("transitionState throws NotFoundError for a session that does not exist", async () => {
    const { tenant } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    await expect(
      repository.transitionState(tenant.id, asWarmupSessionId("00000000-0000-0000-0000-000000000000"), "DRAFT", "ACTIVE"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("recordDailyDecision advances the day and resets per-day counters", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");

    const day1 = await repository.recordDailyDecision(tenant.id, session.id, 1, 5);
    expect(day1.currentDay).toBe(1);
    expect(day1.currentDailyTarget).toBe(5);

    const committed = await repository.commitExecutionVolume(tenant.id, session.id, 1, 5);
    expect(committed?.session.committedVolumeToday).toBe(5);

    const day2 = await repository.recordDailyDecision(tenant.id, session.id, 2, 7);
    expect(day2.currentDay).toBe(2);
    expect(day2.currentDailyTarget).toBe(7);
    expect(day2.committedVolumeToday).toBe(0);
    expect(day2.nextExecutionSlot).toBe(0);
  });

  it("recordDailyDecision does not reset counters when re-recording the same day", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await repository.recordDailyDecision(tenant.id, session.id, 1, 5);
    await repository.commitExecutionVolume(tenant.id, session.id, 1, 3);

    const updated = await repository.recordDailyDecision(tenant.id, session.id, 1, 8);
    expect(updated.currentDailyTarget).toBe(8);
    expect(updated.committedVolumeToday).toBe(3);
  });

  it("recordDailyDecision refuses to move the day backwards", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await repository.recordDailyDecision(tenant.id, session.id, 3, 10);

    await expect(repository.recordDailyDecision(tenant.id, session.id, 2, 5)).rejects.toBeInstanceOf(ConflictError);
  });

  it("commitExecutionVolume allocates sequential slots and accumulates volume", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await repository.recordDailyDecision(tenant.id, session.id, 1, 10);

    const first = await repository.commitExecutionVolume(tenant.id, session.id, 1, 4);
    const second = await repository.commitExecutionVolume(tenant.id, session.id, 1, 4);
    expect(first?.allocatedSlot).toBe(0);
    expect(second?.allocatedSlot).toBe(1);
    expect(second?.session.committedVolumeToday).toBe(8);
  });

  it("commitExecutionVolume refuses to exceed the daily target — the atomic daily-limit guard", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await repository.recordDailyDecision(tenant.id, session.id, 1, 10);

    await repository.commitExecutionVolume(tenant.id, session.id, 1, 8);
    const overLimit = await repository.commitExecutionVolume(tenant.id, session.id, 1, 5);
    expect(overLimit).toBeUndefined();
  });

  it("commitExecutionVolume refuses when the day no longer matches the session's current day", async () => {
    const { tenant, mailbox, profile } = await createFixtures();
    const repository = new PostgresWarmupSessionRepository(handle.database);
    const session = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    await repository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await repository.recordDailyDecision(tenant.id, session.id, 2, 10);

    await expect(repository.commitExecutionVolume(tenant.id, session.id, 1, 5)).resolves.toBeUndefined();
  });

  it("enforces tenant isolation on findOpenByMailbox and findLatestByMailbox", async () => {
    const { tenant: tenantA, mailbox: mailboxA, profile: profileA } = await createFixtures("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const repository = new PostgresWarmupSessionRepository(handle.database);
    await repository.create({ tenantId: tenantA.id, mailboxId: mailboxA.id, profileId: profileA.id });

    await expect(repository.findOpenByMailbox(tenantB.id, mailboxA.id)).resolves.toBeUndefined();
    await expect(repository.findLatestByMailbox(tenantB.id, mailboxA.id)).resolves.toBeUndefined();
  });
});

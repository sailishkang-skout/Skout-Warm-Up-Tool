/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real warmup-profile persistence layer — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { ConflictError } from "../../src/shared/errors/index.js";
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

async function createTenantAndMailbox(emailAddress = "profile@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Profile Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress,
    provider: "GMAIL",
  });
  return { tenant, mailbox };
}

describe("PostgresWarmupProfileRepository", () => {
  it("creates a profile that defaults to inactive", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);

    const profile = await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    expect(profile.active).toBe(false);
    expect(profile.targetDailyVolume).toBe(30);
    expect(profile.pauseConditions).toEqual([]);
  });

  it("persists custom pause conditions", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);

    const profile = await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "CONSERVATIVE",
      riskTolerance: "LOW",
      pauseConditions: ["RISK_CRITICAL", "PROVIDER_DISCONNECTED"],
    });

    expect(profile.pauseConditions).toEqual(["RISK_CRITICAL", "PROVIDER_DISCONNECTED"]);
  });

  it("rejects a second profile for the same mailbox (one profile per mailbox)", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    const input = {
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD" as const,
      riskTolerance: "MEDIUM" as const,
    };

    await repository.create(input);
    await expect(repository.create(input)).rejects.toBeInstanceOf(ConflictError);
  });

  it("findByMailboxId enforces tenant isolation", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const repository = new PostgresWarmupProfileRepository(handle.database);

    await repository.create({
      tenantId: tenantA.id,
      mailboxId: mailboxA.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    await expect(repository.findByMailboxId(tenantB.id, mailboxA.id)).resolves.toBeUndefined();
    await expect(repository.findByMailboxId(tenantA.id, mailboxA.id)).resolves.toBeDefined();
  });

  it("returns undefined when no profile exists yet", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await expect(repository.findByMailboxId(tenant.id, mailbox.id)).resolves.toBeUndefined();
  });

  it("setActive flips the flag Stage 8's WarmupService uses to mark a profile in-use", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    const activated = await repository.setActive(tenant.id, mailbox.id, true);
    expect(activated.active).toBe(true);

    const deactivated = await repository.setActive(tenant.id, mailbox.id, false);
    expect(deactivated.active).toBe(false);
  });

  it("setActive throws NotFoundError for a mailbox with no profile", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await expect(repository.setActive(tenant.id, mailbox.id, true)).rejects.toThrow();
  });

  it("update changes only the fields provided, leaving the rest untouched", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    const updated = await repository.update(tenant.id, mailbox.id, { riskTolerance: "LOW" });
    expect(updated.riskTolerance).toBe("LOW");
    expect(updated.rampStrategy).toBe("STANDARD");
    expect(updated.targetDailyVolume).toBe(30);
  });

  it("update can change pauseConditions", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    const updated = await repository.update(tenant.id, mailbox.id, { pauseConditions: ["RISK_CRITICAL"] });
    expect(updated.pauseConditions).toEqual(["RISK_CRITICAL"]);
  });

  it("update never changes active — there is no such field on UpdateWarmupProfileInput", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });
    await repository.setActive(tenant.id, mailbox.id, true);

    const updated = await repository.update(tenant.id, mailbox.id, { riskTolerance: "HIGH" });
    expect(updated.active).toBe(true);
  });

  it("update throws NotFoundError for a mailbox with no profile", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await expect(repository.update(tenant.id, mailbox.id, { riskTolerance: "LOW" })).rejects.toThrow();
  });

  it("update enforces tenant isolation", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a2@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B2" });
    const repository = new PostgresWarmupProfileRepository(handle.database);
    await repository.create({
      tenantId: tenantA.id,
      mailboxId: mailboxA.id,
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
    });

    await expect(repository.update(tenantB.id, mailboxA.id, { riskTolerance: "LOW" })).rejects.toThrow();
  });
});

/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real warmup-decision persistence layer — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import type { CreateWarmupDecisionInput } from "../../src/modules/warmup/application/warmup-decision-repository.js";
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

async function createFixtures(emailAddress = "decision@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Decision Co" });
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
  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const session = await sessionRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
  return { tenant, mailbox, profile, session };
}

function decisionInput(overrides: Partial<CreateWarmupDecisionInput> = {}): Omit<CreateWarmupDecisionInput, "tenantId" | "sessionId" | "mailboxId"> {
  return {
    warmupDay: 1,
    decision: "PROCEED",
    reasonCodes: ["RAMP_PROGRESSION"],
    reasons: ["Normal progression."],
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
    ...overrides,
  };
}

describe("PostgresWarmupDecisionRepository", () => {
  it("creates and round-trips a decision", async () => {
    const { tenant, mailbox, session } = await createFixtures();
    const repository = new PostgresWarmupDecisionRepository(handle.database);

    const created = await repository.create({ tenantId: tenant.id, sessionId: session.id, mailboxId: mailbox.id, ...decisionInput() });

    expect(created.decision).toBe("PROCEED");
    expect(created.recommendedVolume).toBe(5);
    expect(created.reasonCodes).toEqual(["RAMP_PROGRESSION"]);
    expect(created.profileSnapshot.rampStrategy).toBe("STANDARD");
  });

  it("findById returns undefined for a decision belonging to another tenant", async () => {
    const { tenant, mailbox, session } = await createFixtures();
    const repository = new PostgresWarmupDecisionRepository(handle.database);
    const created = await repository.create({ tenantId: tenant.id, sessionId: session.id, mailboxId: mailbox.id, ...decisionInput() });

    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    await expect(repository.findById(tenantB.id, created.id)).resolves.toBeUndefined();
    await expect(repository.findById(tenant.id, created.id)).resolves.toBeDefined();
  });

  it("listBySession returns newest first, bounded by limit", async () => {
    const { tenant, mailbox, session } = await createFixtures();
    const repository = new PostgresWarmupDecisionRepository(handle.database);

    for (let day = 1; day <= 5; day++) {
      await repository.create({
        tenantId: tenant.id,
        sessionId: session.id,
        mailboxId: mailbox.id,
        ...decisionInput({ warmupDay: day, generatedAt: new Date(Date.now() + day * 1000) }),
      });
    }

    const history = await repository.listBySession(tenant.id, session.id, 3);
    expect(history).toHaveLength(3);
    expect(history[0]!.warmupDay).toBe(5);
    expect(history[1]!.warmupDay).toBe(4);
  });

  it("never overwrites a prior decision — append-only", async () => {
    const { tenant, mailbox, session } = await createFixtures();
    const repository = new PostgresWarmupDecisionRepository(handle.database);
    await repository.create({ tenantId: tenant.id, sessionId: session.id, mailboxId: mailbox.id, ...decisionInput() });
    await repository.create({ tenantId: tenant.id, sessionId: session.id, mailboxId: mailbox.id, ...decisionInput({ decision: "REDUCE" }) });

    const rows = await handle.database.query("SELECT id, decision FROM warmup_decisions WHERE session_id = $1", [session.id]);
    expect(rows).toHaveLength(2);
  });

  it("preserves a BLOCK/PAUSE decision's reasons for later audit — 'why was this mailbox paused'", async () => {
    const { tenant, mailbox, session } = await createFixtures();
    const repository = new PostgresWarmupDecisionRepository(handle.database);
    const created = await repository.create({
      tenantId: tenant.id,
      sessionId: session.id,
      mailboxId: mailbox.id,
      ...decisionInput({ decision: "PAUSE", reasonCodes: ["RISK_CRITICAL"], reasons: ["Risk level is CRITICAL."], recommendedVolume: 0 }),
    });

    expect(created.decision).toBe("PAUSE");
    expect(created.reasons).toContain("Risk level is CRITICAL.");
  });

  it("enforces tenant isolation on listBySession", async () => {
    const { tenant: tenantA, mailbox: mailboxA, session: sessionA } = await createFixtures("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const repository = new PostgresWarmupDecisionRepository(handle.database);
    await repository.create({ tenantId: tenantA.id, sessionId: sessionA.id, mailboxId: mailboxA.id, ...decisionInput() });

    await expect(repository.listBySession(tenantB.id, sessionA.id, 10)).resolves.toEqual([]);
  });
});

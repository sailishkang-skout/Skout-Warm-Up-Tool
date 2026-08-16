/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real assessment-history persistence layer — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { detectChanges } from "../../src/modules/health/domain/assessment-change.js";
import { PostgresMailboxAssessmentRepository } from "../../src/modules/health/infrastructure/postgres-mailbox-assessment-repository.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
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

async function createTenantAndMailbox(emailAddress = "assess@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Assessment Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress,
    provider: "GMAIL",
  });
  return { tenant, mailbox };
}

function snapshotInput(overrides: Partial<Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">> = {}) {
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

describe("PostgresMailboxAssessmentRepository", () => {
  it("creates and round-trips a full snapshot", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    const created = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, snapshot: snapshotInput() });

    expect(created.health.connection).toBe("HEALTHY");
    expect(created.risk.riskLevel).toBe("LOW");
    expect(created.eligibility.decision).toBe("ELIGIBLE");
    expect(created.capacity.recommendedDailyVolume).toBe(10);
  });

  it("findLatest returns the most recently assessed snapshot", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      snapshot: snapshotInput({ risk: { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: new Date(Date.now() - 60_000) } }),
    });
    const second = await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      snapshot: snapshotInput({ risk: { riskLevel: "HIGH", riskScore: 50, riskFactors: [], assessedAt: new Date() } }),
    });

    const latest = await repository.findLatest(tenant.id, mailbox.id);
    expect(latest?.id).toBe(second.id);
    expect(latest?.risk.riskLevel).toBe("HIGH");
  });

  it("returns undefined from findLatest when no assessment exists yet", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);
    await expect(repository.findLatest(tenant.id, mailbox.id)).resolves.toBeUndefined();
  });

  it("listHistory returns snapshots newest first, bounded by limit", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    for (let i = 0; i < 5; i++) {
      await repository.create({
        tenantId: tenant.id,
        mailboxId: mailbox.id,
        snapshot: snapshotInput({ assessedAt: new Date(Date.now() + i * 1000) }),
      });
    }

    const history = await repository.listHistory(tenant.id, mailbox.id, 3);
    expect(history).toHaveLength(3);
    expect(history[0]!.assessedAt.getTime()).toBeGreaterThan(history[1]!.assessedAt.getTime());
    expect(history[1]!.assessedAt.getTime()).toBeGreaterThan(history[2]!.assessedAt.getTime());
  });

  it("never overwrites a prior assessment — history is append-only", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, snapshot: snapshotInput() });
    await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, snapshot: snapshotInput() });

    const rows = await handle.database.query("SELECT id FROM mailbox_assessments WHERE mailbox_id = $1", [mailbox.id]);
    expect(rows).toHaveLength(2);
  });

  it("enforces tenant isolation on findLatest and listHistory", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    await repository.create({ tenantId: tenantA.id, mailboxId: mailboxA.id, snapshot: snapshotInput() });

    await expect(repository.findLatest(tenantB.id, mailboxA.id)).resolves.toBeUndefined();
    await expect(repository.listHistory(tenantB.id, mailboxA.id, 10)).resolves.toEqual([]);
  });

  it("persists and returns the domain assessment snapshot when provided", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);
    const domainAssessment = {
      domain: "example.com",
      mx: { status: "PASS" as const, records: ["mx1.example.com"] },
      spf: { status: "PASS" as const, record: "v=spf1 -all" },
      dkim: { status: "MISSING" as const },
      dmarc: { status: "PASS" as const, policy: "reject" as const, record: "v=DMARC1; p=reject" },
      checkedAt: new Date(),
    };

    const created = await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      snapshot: snapshotInput({ domainAssessment }),
    });

    expect(created.domainAssessment?.domain).toBe("example.com");
    expect(created.domainAssessment?.dmarc.policy).toBe("reject");
    expect(created.domainAssessment?.checkedAt).toBeInstanceOf(Date);
  });

  it("supports change detection across two real, persisted snapshots", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxAssessmentRepository(handle.database);

    const first = await repository.create({ tenantId: tenant.id, mailboxId: mailbox.id, snapshot: snapshotInput() });
    const second = await repository.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      snapshot: snapshotInput({
        health: { ...snapshotInput().health, connection: "UNHEALTHY" },
        risk: { riskLevel: "HIGH", riskScore: 40, riskFactors: [], assessedAt: new Date() },
        eligibility: { decision: "NOT_ELIGIBLE", reasons: ["disconnected"], assessedAt: new Date() },
      }),
    });

    const changes = detectChanges(first, second);
    expect(changes).toContainEqual({ field: "riskLevel", previousValue: "LOW", newValue: "HIGH" });
    expect(changes).toContainEqual({ field: "eligibilityDecision", previousValue: "ELIGIBLE", newValue: "NOT_ELIGIBLE" });
    expect(changes).toContainEqual({ field: "health.connection", previousValue: "HEALTHY", newValue: "UNHEALTHY" });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../../src/modules/providers/infrastructure/postgres-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { createWarmupService } from "../../src/modules/warmup/application/warmup-service.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { createWarmupPoolService } from "../../src/modules/warmup-pool/application/warmup-pool-service.js";
import { PostgresWarmupPoolRepository } from "../../src/modules/warmup-pool/infrastructure/postgres-warmup-pool-repository.js";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { PolicyError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import type { TenantId } from "../../src/shared/types/index.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const poolConfig = loadConfig({ NODE_ENV: "test" }).warmupPool;

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

async function seedMailbox(tenantId: TenantId, email: string, status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId,
    emailAddress: email,
    provider: "GMAIL",
    status,
  });
  const account = await new PostgresProviderAccountRepository(handle.database).create({
    tenantId,
    mailboxId: mailbox.id,
    provider: "GMAIL",
    status: "ACTIVE",
  });
  await handle.database.query(
    `INSERT INTO provider_credentials (provider_account_id, credential_type, encrypted_payload, encryption_version, status)
     VALUES ($1, 'GOOGLE_OAUTH', 'ciphertext', 1, 'ACTIVE')`,
    [account.id],
  );
  await handle.database.query(
    `INSERT INTO mailbox_assessments (
       tenant_id, mailbox_id, connection_health, authentication_health, sending_health, receiving_health,
       domain_health, configuration_health, risk_level, risk_score, eligibility_decision,
       recommended_daily_volume, minimum_daily_volume, maximum_daily_volume, capacity_confidence
     ) VALUES ($1, $2, 'HEALTHY', 'HEALTHY', 'HEALTHY', 'HEALTHY', 'HEALTHY', 'HEALTHY', 'LOW', 5, 'ELIGIBLE', 5, 1, 20, 'HIGH')`,
    [tenantId, mailbox.id],
  );
  await handle.database.query(
    `INSERT INTO reputation_assessments (
       tenant_id, mailbox_id, status, confidence, factors, trends, last_24h, last_7d, lifetime, assessed_at
     ) VALUES ($1, $2, 'HEALTHY', 'LOW', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
    [tenantId, mailbox.id],
  );
  return mailbox;
}

function services() {
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
  const encryptionService = createEncryptionService([{ version: 1, rawKey: "a".repeat(32) }], 1);
  const mailboxService = createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry: createProviderRegistry(),
    credentialStore: createPostgresProviderCredentialStore(handle.database, encryptionService),
    auditRecorder,
  });
  const warmupService = createWarmupService({
    mailboxService,
    mailboxAssessmentService: {
      getAssessment: async () => {
        throw new Error("not used");
      },
      refreshAssessment: async () => {
        throw new Error("not used");
      },
      getHistory: async () => [],
    },
    warmupProfileRepository: new PostgresWarmupProfileRepository(handle.database),
    sessionRepository: new PostgresWarmupSessionRepository(handle.database),
    decisionRepository: new PostgresWarmupDecisionRepository(handle.database),
    intentRepository: new PostgresWarmupExecutionIntentRepository(handle.database),
    auditRecorder,
  });
  const repository = new PostgresWarmupPoolRepository(handle.database);
  const service = createWarmupPoolService({
    database: handle.database,
    repository,
    mailboxService,
    warmupService,
    auditRecorder,
    config: poolConfig,
  });
  return { service, repository, mailboxService };
}

describe("warmup identity pools", () => {
  it("creates a pool and membership with tenant isolation", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Pool Co" });
    const other = await new PostgresTenantRepository(handle.database).create({ name: "Other Co" });
    const mailbox = await seedMailbox(tenant.id, "a@one.test");
    const { service } = services();
    const pool = await service.createPool(tenant.id, { name: "senders" });
    const membership = await service.addMailbox(tenant.id, pool.id, { mailboxId: mailbox.id, maxDailyWarmupVolume: 2 });
    expect(membership.mailboxId).toBe(mailbox.id);
    await expect(service.listPools(other.id)).resolves.toEqual([]);
    await expect(service.getPool(other.id, pool.id)).rejects.toThrow(/was not found/);
  });

  it("rejects cross-tenant membership via the database trigger", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "A" });
    const other = await new PostgresTenantRepository(handle.database).create({ name: "B" });
    const mailbox = await seedMailbox(other.id, "x@other.test");
    const { service } = services();
    const pool = await service.createPool(tenant.id, { name: "senders" });
    await expect(service.addMailbox(tenant.id, pool.id, { mailboxId: mailbox.id })).rejects.toThrow();
  });

  it("selects deterministically and rotates across domains", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Rotate Co" });
    const one = await seedMailbox(tenant.id, "a@one.test");
    const two = await seedMailbox(tenant.id, "b@two.test");
    const { service } = services();
    const pool = await service.createPool(tenant.id, {
      name: "senders",
      strategy: "LEAST_USED",
      maxConsecutiveSameDomain: 1,
    });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: one.id });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: two.id });
    const first = await service.selectNextMailbox(tenant.id, pool.id, new Date("2026-08-19T12:00:00.000Z"));
    const second = await service.selectNextMailbox(tenant.id, pool.id, new Date("2026-08-19T12:00:01.000Z"));
    expect(first.mailboxId).not.toBe(second.mailboxId);
    expect(new Set([first.domain, second.domain])).toEqual(new Set(["one.test", "two.test"]));
  });

  it("does not double-select beyond membership daily capacity under concurrency", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Cap Co" });
    const mailbox = await seedMailbox(tenant.id, "only@one.test");
    const { service } = services();
    const pool = await service.createPool(tenant.id, { name: "senders" });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: mailbox.id, maxDailyWarmupVolume: 1 });
    const now = new Date("2026-08-19T12:00:00.000Z");
    const results = await Promise.allSettled([
      service.selectNextMailbox(tenant.id, pool.id, now),
      service.selectNextMailbox(tenant.id, pool.id, now),
    ]);
    const selected = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(selected).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(PolicyError);
    expect((failed[0] as PromiseRejectedResult).reason.message).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
  });

  it("honors cooldown after selection", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Cool Co" });
    const mailbox = await seedMailbox(tenant.id, "a@one.test");
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const encryptionService = createEncryptionService([{ version: 1, rawKey: "a".repeat(32) }], 1);
    const mailboxService = createMailboxService({
      database: handle.database,
      mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
      providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
      providerRegistry: createProviderRegistry(),
      credentialStore: createPostgresProviderCredentialStore(handle.database, encryptionService),
      auditRecorder,
    });
    const warmupService = createWarmupService({
      mailboxService,
      mailboxAssessmentService: {
        getAssessment: async () => {
          throw new Error("not used");
        },
        refreshAssessment: async () => {
          throw new Error("not used");
        },
        getHistory: async () => [],
      },
      warmupProfileRepository: new PostgresWarmupProfileRepository(handle.database),
      sessionRepository: new PostgresWarmupSessionRepository(handle.database),
      decisionRepository: new PostgresWarmupDecisionRepository(handle.database),
      intentRepository: new PostgresWarmupExecutionIntentRepository(handle.database),
      auditRecorder,
    });
    const service = createWarmupPoolService({
      database: handle.database,
      repository: new PostgresWarmupPoolRepository(handle.database),
      mailboxService,
      warmupService,
      auditRecorder,
      config: { ...poolConfig, selectionCooldownMs: 60_000 },
    });
    const pool = await service.createPool(tenant.id, { name: "senders" });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: mailbox.id, maxDailyWarmupVolume: 10 });
    await service.selectNextMailbox(tenant.id, pool.id, new Date("2026-08-19T12:00:00.000Z"));
    await expect(service.selectNextMailbox(tenant.id, pool.id, new Date("2026-08-19T12:00:01.000Z"))).rejects.toThrow(
      "NO_ELIGIBLE_WARMUP_MAILBOX",
    );
  });

  it("does not rewrite historical execution intents", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Intent Co" });
    const mailbox = await seedMailbox(tenant.id, "a@one.test");
    const other = await seedMailbox(tenant.id, "b@two.test");
    const profileRepo = new PostgresWarmupProfileRepository(handle.database);
    const sessionRepo = new PostgresWarmupSessionRepository(handle.database);
    const decisionRepo = new PostgresWarmupDecisionRepository(handle.database);
    const intentRepo = new PostgresWarmupExecutionIntentRepository(handle.database);
    const profile = await profileRepo.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      startingDailyVolume: 1,
      targetDailyVolume: 5,
      maximumDailyVolume: 10,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
      pauseConditions: [],
    });
    const session = await sessionRepo.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
    const activated = await sessionRepo.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
    await sessionRepo.recordDailyDecision(tenant.id, activated.id, 1, 1);
    const committed = await sessionRepo.commitExecutionVolume(tenant.id, activated.id, 1, 1);
    const decision = await decisionRepo.create({
      tenantId: tenant.id,
      sessionId: activated.id,
      mailboxId: mailbox.id,
      warmupDay: 1,
      decision: "PROCEED",
      reasonCodes: [],
      reasons: [],
      recommendedVolume: 1,
      maximumVolume: 10,
      riskLevel: "LOW",
      eligibility: "ELIGIBLE",
      profileSnapshot: {
        targetDailyVolume: 5,
        startingDailyVolume: 1,
        maximumDailyVolume: 10,
        rampStrategy: "STANDARD",
        riskTolerance: "MEDIUM",
        active: true,
        pauseConditions: [],
      },
      generatedAt: new Date(),
    });
    const intent = await intentRepo.createIfAbsent({
      tenantId: tenant.id,
      sessionId: activated.id,
      mailboxId: mailbox.id,
      decisionId: decision.id,
      provider: "GMAIL",
      warmupDay: 1,
      executionSlot: committed!.allocatedSlot,
      idempotencyKey: computeIdempotencyKey({
        tenantId: tenant.id,
        sessionId: activated.id,
        warmupDay: 1,
        executionSlot: committed!.allocatedSlot,
      }),
      volume: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { service } = services();
    const pool = await service.createPool(tenant.id, { name: "senders", strategy: "LEAST_USED" });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: mailbox.id });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: other.id });
    await service.selectNextMailbox(tenant.id, pool.id);
    const reloaded = await intentRepo.findById(tenant.id, intent.id);
    expect(reloaded?.mailboxId).toBe(mailbox.id);
    expect(reloaded?.idempotencyKey).toBe(intent.idempotencyKey);
  });

  it("skips unhealthy mailboxes instead of selecting them", async () => {
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Health Co" });
    const healthy = await seedMailbox(tenant.id, "ok@one.test");
    const bad = await seedMailbox(tenant.id, "bad@two.test");
    await handle.database.query(
      `INSERT INTO mailbox_assessments (
         tenant_id, mailbox_id, connection_health, authentication_health, sending_health, receiving_health,
         domain_health, configuration_health, risk_level, risk_score, eligibility_decision,
         recommended_daily_volume, minimum_daily_volume, maximum_daily_volume, capacity_confidence
       ) VALUES ($1, $2, 'UNHEALTHY', 'HEALTHY', 'UNHEALTHY', 'HEALTHY', 'HEALTHY', 'HEALTHY', 'CRITICAL', 99, 'NOT_ELIGIBLE', 0, 0, 0, 'LOW')`,
      [tenant.id, bad.id],
    );
    const { service } = services();
    const pool = await service.createPool(tenant.id, { name: "senders" });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: healthy.id });
    await service.addMailbox(tenant.id, pool.id, { mailboxId: bad.id });
    const selected = await service.selectNextMailbox(tenant.id, pool.id);
    expect(selected.mailboxId).toBe(healthy.id);
  });
});

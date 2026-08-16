/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real reputation service — rolling-window aggregation over real
 * delivery events, persistence, and history — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import type { AssessmentInvalidationStore } from "../../src/modules/health/application/assessment-invalidation-store.js";
import { createDeliveryEventService, type DeliveryEventService } from "../../src/modules/delivery-events/application/delivery-event-service.js";
import { PostgresDeliveryEventRepository } from "../../src/modules/delivery-events/infrastructure/postgres-delivery-event-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { SmtpImapAdapter } from "../../src/modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { createReputationService } from "../../src/modules/reputation/application/reputation-service.js";
import { PostgresReputationRepository } from "../../src/modules/reputation/infrastructure/postgres-reputation-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import type { MailboxId, TenantId } from "../../src/shared/types/index.js";
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

function noopInvalidationStore(): AssessmentInvalidationStore {
  return { async markStale() {}, async isStale() { return false; }, async clear() {} };
}

function buildMailboxService() {
  const providerRegistry = createProviderRegistry();
  providerRegistry.register(new GmailAdapter());
  providerRegistry.register(new Microsoft365Adapter());
  providerRegistry.register(new SmtpImapAdapter());

  return createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry,
    credentialStore: createInMemoryProviderCredentialStore({ isProduction: false }),
    auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
  });
}

async function createTenantAndMailbox(emailAddress = "reputation@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Reputation Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress, provider: "GMAIL" });
  return { tenant, mailbox };
}

function buildServices() {
  const deliveryEventService: DeliveryEventService = createDeliveryEventService({
    deliveryEventRepository: new PostgresDeliveryEventRepository(handle.database),
    mailboxService: buildMailboxService(),
    invalidationStore: noopInvalidationStore(),
    auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
  });
  const reputationService = createReputationService({
    deliveryEventService,
    reputationRepository: new PostgresReputationRepository(handle.database),
    auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
  });
  return { deliveryEventService, reputationService };
}

async function seedEvents(deliveryEventService: DeliveryEventService, tenantId: TenantId, mailboxId: MailboxId, count: number, eventType: "DELIVERED" | "BOUNCED" | "COMPLAINT") {
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await deliveryEventService.ingestDeliveryEvent({
      tenantId,
      mailboxId,
      provider: "GMAIL",
      providerEventId: `${eventType}-${i}-${Math.random()}`,
      eventType,
      observedAt: new Date(),
      source: "INTERNAL_API",
    });
  }
}

describe("ReputationService.assessReputation", () => {
  it("computes UNKNOWN status for a mailbox with no delivery evidence yet", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { reputationService } = buildServices();

    const assessment = await reputationService.assessReputation(tenant.id, mailbox.id);
    expect(assessment.status).toBe("UNKNOWN");
    expect(assessment.lifetime.eventCount).toBe(0);
  });

  it("computes a HEALTHY assessment from real delivered events", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { deliveryEventService, reputationService } = buildServices();
    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 15, "DELIVERED");

    const assessment = await reputationService.assessReputation(tenant.id, mailbox.id);
    expect(assessment.status).toBe("HEALTHY");
    expect(assessment.factors).toEqual([]);
    expect(assessment.lifetime.eventCount).toBe(15);
  });

  it("computes a degraded assessment with a HIGH_BOUNCE_RATE factor from real bounce events", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { deliveryEventService, reputationService } = buildServices();
    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 8, "DELIVERED");
    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 8, "BOUNCED");

    const assessment = await reputationService.assessReputation(tenant.id, mailbox.id);
    expect(assessment.factors.map((f) => f.code)).toContain("HIGH_BOUNCE_RATE");
    expect(["DEGRADED", "POOR", "CRITICAL"]).toContain(assessment.status);
  });

  it("persists an append-only history — each assessReputation call creates a new row, never overwrites the prior one", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { deliveryEventService, reputationService } = buildServices();
    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 10, "DELIVERED");

    const first = await reputationService.assessReputation(tenant.id, mailbox.id);
    const second = await reputationService.assessReputation(tenant.id, mailbox.id);
    expect(first.id).not.toBe(second.id);

    const history = await reputationService.getHistory(tenant.id, mailbox.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]?.id).toBe(second.id); // newest first
  });

  it("getLatest returns undefined for a mailbox never assessed, without triggering a computation", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { reputationService } = buildServices();
    await expect(reputationService.getLatest(tenant.id, mailbox.id)).resolves.toBeUndefined();
  });

  it("is tenant-scoped — one tenant's assessment history is never visible to another", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const { deliveryEventService, reputationService } = buildServices();
    await seedEvents(deliveryEventService, tenantA.id, mailboxA.id, 10, "DELIVERED");
    await reputationService.assessReputation(tenantA.id, mailboxA.id);

    await expect(reputationService.getLatest(tenantB.id, mailboxA.id)).resolves.toBeUndefined();
  });

  it("records REPUTATION_ASSESSMENT_CREATED on every run, and REPUTATION_DEGRADED exactly once on the transition into a degraded status", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { deliveryEventService, reputationService } = buildServices();

    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 15, "DELIVERED");
    await reputationService.assessReputation(tenant.id, mailbox.id); // HEALTHY

    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 10, "BOUNCED");
    await reputationService.assessReputation(tenant.id, mailbox.id); // now degraded
    await reputationService.assessReputation(tenant.id, mailbox.id); // stays degraded — should not re-fire REPUTATION_DEGRADED

    const created = await handle.database.query("SELECT id FROM audit_events WHERE event_type = 'REPUTATION_ASSESSMENT_CREATED' AND tenant_id = $1", [tenant.id]);
    const degraded = await handle.database.query("SELECT id FROM audit_events WHERE event_type = 'REPUTATION_DEGRADED' AND tenant_id = $1", [tenant.id]);
    expect(created).toHaveLength(3);
    expect(degraded).toHaveLength(1);
  });

  it("never persists a raw provider payload or credential-shaped value in an assessment row", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const { deliveryEventService, reputationService } = buildServices();
    await seedEvents(deliveryEventService, tenant.id, mailbox.id, 10, "DELIVERED");

    const assessment = await reputationService.assessReputation(tenant.id, mailbox.id);
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password|secretData|Authorization/i);
  });
});

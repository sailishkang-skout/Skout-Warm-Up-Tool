/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real delivery-event persistence layer and ingestion service — no
 * mocked SQL behavior. Concurrency test proves the actual idempotency
 * guarantee (Stage 10 spec section 3): 10 concurrent identical events must
 * persist as exactly 1 logical event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import type { AssessmentInvalidationStore } from "../../src/modules/health/application/assessment-invalidation-store.js";
import { createDeliveryEventService } from "../../src/modules/delivery-events/application/delivery-event-service.js";
import { PostgresDeliveryEventRepository } from "../../src/modules/delivery-events/infrastructure/postgres-delivery-event-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { SmtpImapAdapter } from "../../src/modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { NotFoundError } from "../../src/shared/errors/index.js";
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

function fakeInvalidationStore(): AssessmentInvalidationStore & { staleCalls: string[] } {
  const staleCalls: string[] = [];
  return {
    staleCalls,
    async markStale(tenantId, mailboxId) {
      staleCalls.push(`${tenantId}:${mailboxId}`);
    },
    async isStale() {
      return false;
    },
    async clear() {},
  };
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

async function createTenantAndMailbox(emailAddress = "delivery@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Delivery Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress, provider: "GMAIL" });
  return { tenant, mailbox };
}

function buildDeliveryEventService(invalidationStore: AssessmentInvalidationStore = fakeInvalidationStore()) {
  return createDeliveryEventService({
    deliveryEventRepository: new PostgresDeliveryEventRepository(handle.database),
    mailboxService: buildMailboxService(),
    invalidationStore,
    auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
  });
}

describe("DeliveryEventService.ingestDeliveryEvent", () => {
  it("persists a new delivery event", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();

    const { event, wasNew } = await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-1",
      eventType: "DELIVERED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });

    expect(wasNew).toBe(true);
    expect(event.eventType).toBe("DELIVERED");
    expect(event.mailboxId).toBe(mailbox.id);
  });

  it("is idempotent by providerEventId — a second ingestion of the same event returns the same row and wasNew: false", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();

    const first = await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-dup",
      eventType: "BOUNCED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });
    const second = await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-dup",
      eventType: "BOUNCED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });

    expect(second.wasNew).toBe(false);
    expect(second.event.id).toBe(first.event.id);

    const rows = await handle.database.query("SELECT COUNT(*)::text AS count FROM delivery_events WHERE mailbox_id = $1", [mailbox.id]);
    expect((rows[0] as { count: string }).count).toBe("1");
  });

  it("10 concurrent identical ingestion requests persist exactly 1 logical event", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();
    const observedAt = new Date();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.ingestDeliveryEvent({
          tenantId: tenant.id,
          mailboxId: mailbox.id,
          provider: "GMAIL",
          providerEventId: "evt-concurrent",
          eventType: "COMPLAINT",
          observedAt,
          source: "INTERNAL_API",
        }),
      ),
    );

    const newCount = results.filter((r) => r.wasNew).length;
    expect(newCount).toBe(1);
    const distinctIds = new Set(results.map((r) => r.event.id));
    expect(distinctIds.size).toBe(1);

    const rows = await handle.database.query("SELECT COUNT(*)::text AS count FROM delivery_events WHERE mailbox_id = $1", [mailbox.id]);
    expect((rows[0] as { count: string }).count).toBe("1");
  });

  it("rejects a mailbox that does not belong to the given tenant", async () => {
    const { mailbox } = await createTenantAndMailbox();
    const otherTenant = await new PostgresTenantRepository(handle.database).create({ name: "Other Co" });
    const service = buildDeliveryEventService();

    await expect(
      service.ingestDeliveryEvent({
        tenantId: otherTenant.id,
        mailboxId: mailbox.id,
        provider: "GMAIL",
        eventType: "DELIVERED",
        observedAt: new Date(),
        source: "INTERNAL_API",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("marks the mailbox's intelligence stale on a new event, but not on a duplicate", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const invalidationStore = fakeInvalidationStore();
    const service = buildDeliveryEventService(invalidationStore);

    await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-stale-1",
      eventType: "DELIVERED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });
    expect(invalidationStore.staleCalls).toHaveLength(1);

    await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-stale-1",
      eventType: "DELIVERED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });
    expect(invalidationStore.staleCalls).toHaveLength(1);
  });

  it("records a DELIVERY_EVENT_RECEIVED audit event for a new event and DELIVERY_EVENT_DUPLICATE for a repeat, both with safe metadata only", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();

    await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-audit",
      eventType: "DELIVERED",
      observedAt: new Date(),
      source: "INTERNAL_API",
      metadata: { note: "safe detail" },
    });
    await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-audit",
      eventType: "DELIVERED",
      observedAt: new Date(),
      source: "INTERNAL_API",
    });

    const received = await handle.database.query(
      "SELECT metadata FROM audit_events WHERE event_type = 'DELIVERY_EVENT_RECEIVED' AND tenant_id = $1",
      [tenant.id],
    );
    const duplicate = await handle.database.query(
      "SELECT metadata FROM audit_events WHERE event_type = 'DELIVERY_EVENT_DUPLICATE' AND tenant_id = $1",
      [tenant.id],
    );
    expect(received).toHaveLength(1);
    expect(duplicate).toHaveLength(1);
    const serialized = JSON.stringify([...received, ...duplicate]);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password|secretData|Authorization/i);
  });

  it("never persists a raw sensitive-looking metadata value — defense in depth redacts it before it reaches Postgres", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();

    const { event } = await service.ingestDeliveryEvent({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      providerEventId: "evt-secret",
      eventType: "BOUNCED",
      observedAt: new Date(),
      source: "INTERNAL_API",
      metadata: { accessToken: "should-never-be-stored", note: "reason for bounce" },
    });

    const rows = await handle.database.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM delivery_events WHERE id = $1", [event.id]);
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("should-never-be-stored");
    expect(JSON.stringify(rows[0]?.metadata)).toContain("[REDACTED]");
  });
});

describe("DeliveryEventService.getWindowStats", () => {
  it("counts events by type within the given window and excludes events outside it", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const service = buildDeliveryEventService();
    const now = new Date();
    const insideWindow = new Date(now.getTime() - 60_000);
    const outsideWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", providerEventId: "a", eventType: "DELIVERED", observedAt: insideWindow, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", providerEventId: "b", eventType: "BOUNCED", observedAt: insideWindow, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", providerEventId: "c", eventType: "DELIVERED", observedAt: outsideWindow, source: "INTERNAL_API" });

    const stats = await service.getWindowStats(tenant.id, mailbox.id, new Date(now.getTime() - 24 * 60 * 60 * 1000), now);
    expect(stats.counts.DELIVERED).toBe(1);
    expect(stats.counts.BOUNCED).toBe(1);
    expect(stats.total).toBe(2);
  });

  it("is tenant-scoped — never counts another tenant's events for the same mailbox id coincidence is impossible, but cross-tenant isolation is still verified via a second tenant/mailbox pair", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const mailboxB = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenantB.id, emailAddress: "b@example.com", provider: "GMAIL" });
    const service = buildDeliveryEventService();
    const now = new Date();

    await service.ingestDeliveryEvent({ tenantId: tenantA.id, mailboxId: mailboxA.id, provider: "GMAIL", providerEventId: "x", eventType: "DELIVERED", observedAt: now, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenantB.id, mailboxId: mailboxB.id, provider: "GMAIL", providerEventId: "y", eventType: "DELIVERED", observedAt: now, source: "INTERNAL_API" });

    const statsA = await service.getWindowStats(tenantA.id, mailboxA.id, new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    expect(statsA.total).toBe(1);
  });
});

describe("DeliveryEventService.getProviderWindowStats / getDomainWindowStats (Stage 11)", () => {
  it("getProviderWindowStats aggregates across every mailbox on that provider for the tenant", async () => {
    const { tenant, mailbox: mailboxA } = await createTenantAndMailbox("provider-agg-a@example.com");
    const mailboxB = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress: "provider-agg-b@example.com", provider: "GMAIL" });
    const mailboxC = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress: "provider-agg-c@example.com", provider: "MICROSOFT365" });
    const service = buildDeliveryEventService();
    const now = new Date();

    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxA.id, provider: "GMAIL", providerEventId: "a", eventType: "DELIVERED", observedAt: now, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxB.id, provider: "GMAIL", providerEventId: "b", eventType: "BOUNCED", observedAt: now, source: "INTERNAL_API" });
    // Different provider — must not be counted in the GMAIL aggregate.
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxC.id, provider: "MICROSOFT365", providerEventId: "c", eventType: "FAILED", observedAt: now, source: "INTERNAL_API" });

    const stats = await service.getProviderWindowStats(tenant.id, "GMAIL", new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    expect(stats.counts.DELIVERED).toBe(1);
    expect(stats.counts.BOUNCED).toBe(1);
    expect(stats.counts.FAILED).toBe(0);
    expect(stats.total).toBe(2);
  });

  it("getDomainWindowStats aggregates across every mailbox sharing that sending domain for the tenant", async () => {
    const { tenant, mailbox: mailboxA } = await createTenantAndMailbox("domain-agg-a@shared.example.com");
    const mailboxB = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress: "domain-agg-b@shared.example.com", provider: "MICROSOFT365" });
    const mailboxC = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress: "domain-agg-c@other.example.com", provider: "GMAIL" });
    const service = buildDeliveryEventService();
    const now = new Date();

    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxA.id, provider: "GMAIL", providerEventId: "a", eventType: "DELIVERED", observedAt: now, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxB.id, provider: "MICROSOFT365", providerEventId: "b", eventType: "COMPLAINT", observedAt: now, source: "INTERNAL_API" });
    // Different sending domain — must not be counted in the shared.example.com aggregate.
    await service.ingestDeliveryEvent({ tenantId: tenant.id, mailboxId: mailboxC.id, provider: "GMAIL", providerEventId: "c", eventType: "REJECTED", observedAt: now, source: "INTERNAL_API" });

    const stats = await service.getDomainWindowStats(tenant.id, "shared.example.com", new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    expect(stats.counts.DELIVERED).toBe(1);
    expect(stats.counts.COMPLAINT).toBe(1);
    expect(stats.counts.REJECTED).toBe(0);
    expect(stats.total).toBe(2);
  });

  it("both aggregates are tenant-isolated", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("iso-a@iso.example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Isolated Provider Tenant B" });
    const mailboxB = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenantB.id, emailAddress: "iso-b@iso.example.com", provider: "GMAIL" });
    const service = buildDeliveryEventService();
    const now = new Date();

    await service.ingestDeliveryEvent({ tenantId: tenantA.id, mailboxId: mailboxA.id, provider: "GMAIL", providerEventId: "a", eventType: "DELIVERED", observedAt: now, source: "INTERNAL_API" });
    await service.ingestDeliveryEvent({ tenantId: tenantB.id, mailboxId: mailboxB.id, provider: "GMAIL", providerEventId: "b", eventType: "BOUNCED", observedAt: now, source: "INTERNAL_API" });

    const providerStatsA = await service.getProviderWindowStats(tenantA.id, "GMAIL", new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    expect(providerStatsA.total).toBe(1);
    expect(providerStatsA.counts.BOUNCED).toBe(0);

    const domainStatsA = await service.getDomainWindowStats(tenantA.id, "iso.example.com", new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000));
    expect(domainStatsA.total).toBe(1);
    expect(domainStatsA.counts.BOUNCED).toBe(0);
  });
});

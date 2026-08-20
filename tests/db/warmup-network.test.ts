import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWarmupNetworkRouter } from "../../src/modules/warmup-network/application/warmup-network-router.js";
import { PostgresWarmupNetworkRepository } from "../../src/modules/warmup-network/infrastructure/postgres-warmup-network-repository.js";
import { METRIC, readCounter, resetCountersForTests } from "../../src/shared/observability/index.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../../src/modules/providers/infrastructure/postgres-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { loadConfig } from "../../src/shared/config/index.js";
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
const config = loadConfig({ NODE_ENV: "test" }).warmupNetwork;

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
  resetCountersForTests();
});

afterAll(async () => {
  if (handle) await handle.database.close();
});

async function seedCustomer(name: string, email: string, status: "CONNECTED" | "DISCONNECTED" = "CONNECTED") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress: email,
    provider: "GMAIL",
    status,
  });
  return { tenant, mailbox };
}

async function seedNetwork(options?: {
  mailboxCapacity?: number;
  mailboxCount?: number;
  secondProvider?: boolean;
  secondDomain?: boolean;
}) {
  const capacity = options?.mailboxCapacity ?? 50;
  const mailboxCount = options?.mailboxCount ?? 2;
  const operator = await new PostgresTenantRepository(handle.database).create({ name: "Skout Network Ops" });
  const mailboxRepo = new PostgresMailboxRepository(handle.database);
  const linked = [];
  for (let i = 0; i < mailboxCount; i += 1) {
    const provider = options?.secondProvider && i === 1 ? "MICROSOFT365" : "GMAIL";
    linked.push(
      await mailboxRepo.create({
        tenantId: operator.id,
        emailAddress: `partner${i}@skout-warmup.test`,
        provider,
        status: "CONNECTED",
      }),
    );
  }

  const networkRows = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_networks (name, status) VALUES ('skout-managed', 'ACTIVE') RETURNING id`,
  );
  const networkId = networkRows[0]!.id;
  const poolRows = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_network_pools (network_id, name, status) VALUES ($1, 'default', 'ACTIVE') RETURNING id`,
    [networkId],
  );
  const poolId = poolRows[0]!.id;
  const domainRows = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_network_domains (
       network_id, pool_id, domain, provider, status, authentication_status, spf_status, dkim_status, dmarc_status,
       reputation_status, health_score, daily_capacity
     ) VALUES ($1, $2, 'skout-warmup.test', 'GMAIL', 'ACTIVE', 'PASS', 'PASS', 'PASS', 'PASS', 'HEALTHY', 90, 100)
     RETURNING id`,
    [networkId, poolId],
  );
  const domainId = domainRows[0]!.id;

  let secondDomainId: string | undefined;
  if (options?.secondDomain) {
    const second = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_domains (
         network_id, pool_id, domain, provider, status, authentication_status, spf_status, dkim_status, dmarc_status,
         reputation_status, health_score, daily_capacity
       ) VALUES ($1, $2, 'skout-warmup-b.test', 'GMAIL', 'ACTIVE', 'PASS', 'PASS', 'PASS', 'PASS', 'HEALTHY', 90, 100)
       RETURNING id`,
      [networkId, poolId],
    );
    secondDomainId = second[0]!.id;
  }

  const networkMailboxes = [];
  for (const [index, mailbox] of linked.entries()) {
    const mailboxDomainId = options?.secondDomain && index > 0 && secondDomainId ? secondDomainId : domainId;
    const rows = await handle.database.query<{ id: string; mailbox_address: string; domain_id: string }>(
      `INSERT INTO warmup_network_mailboxes (
         domain_id, pool_id, mailbox_id, provider, provider_mailbox_identifier, mailbox_address,
         status, health_score, reputation_state, daily_capacity
       ) VALUES ($1, $2, $3, $4, $5, $5, 'ACTIVE', $6, 'HEALTHY', $7)
       RETURNING id, mailbox_address, domain_id`,
      [mailboxDomainId, poolId, mailbox.id, mailbox.provider, mailbox.emailAddressCanonical, 80 - index, capacity],
    );
    networkMailboxes.push(rows[0]!);
  }

  return { operator, domainId, secondDomainId, poolId, networkId, networkMailboxes, linked };
}

function router() {
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
  const mailboxService = createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry: createProviderRegistry(),
    credentialStore: createPostgresProviderCredentialStore(
      handle.database,
      createEncryptionService([{ version: 1, rawKey: "warmup-network-db-test-key-32chars!!" }], 1),
    ),
    auditRecorder,
  });
  return createWarmupNetworkRouter({
    database: handle.database,
    mailboxService,
    repository: new PostgresWarmupNetworkRepository(handle.database),
    auditRecorder,
    config,
  });
}

describe("warmup network routing (db)", () => {
  it("selects deterministically and rotates away from a recent partner", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    const seeded = await seedNetwork({ mailboxCount: 2 });
    const networkRouter = router();
    const now = new Date("2026-08-19T12:00:00.000Z");

    const first = await networkRouter.selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "key-1",
      now,
    });
    expect(first.decision.outcome).toBe("SELECTED");
    const second = await networkRouter.selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "key-2",
      now,
    });
    expect(second.decision.outcome).toBe("SELECTED");
    expect(second.selected?.networkMailboxId).not.toBe(first.selected?.networkMailboxId);
    expect(seeded.networkMailboxes.map((row) => row.id)).toContain(first.selected?.networkMailboxId);
  });

  it("returns the existing decision for a duplicate request key without consuming more capacity", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    await seedNetwork({ mailboxCount: 1, mailboxCapacity: 1 });
    const networkRouter = router();
    const now = new Date("2026-08-19T12:00:00.000Z");
    const first = await networkRouter.selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "same-key",
      now,
    });
    const second = await networkRouter.selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "same-key",
      now,
    });
    expect(second.decision.id).toBe(first.decision.id);
    const usage = await handle.database.query<{ usage_count: number }>(`SELECT usage_count FROM warmup_network_mailboxes`);
    expect(usage[0]?.usage_count).toBe(1);
  });

  it("does not over-allocate when two concurrent selects compete for capacity 1", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    await seedNetwork({ mailboxCount: 1, mailboxCapacity: 1 });
    const networkRouter = router();
    const now = new Date("2026-08-19T12:00:00.000Z");
    const [a, b] = await Promise.all([
      networkRouter.selectWarmupMailbox({
        customerTenantId: tenant.id,
        customerMailboxId: mailbox.id,
        requestKey: "concurrent-a",
        now,
      }),
      networkRouter.selectWarmupMailbox({
        customerTenantId: tenant.id,
        customerMailboxId: mailbox.id,
        requestKey: "concurrent-b",
        now,
      }),
    ]);
    const selected = [a, b].filter((result) => result.decision.outcome === "SELECTED");
    const rejected = [a, b].filter((result) => result.decision.outcome === "NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(selected).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureClass).toBe("TEMPORARY");
    const usage = await handle.database.query<{ usage_count: number }>(`SELECT usage_count FROM warmup_network_mailboxes`);
    expect(usage[0]?.usage_count).toBe(1);
  });

  it("does not treat another tenant's recent decisions as recent for this customer", async () => {
    const a = await seedCustomer("A", "a@example.com");
    const b = await seedCustomer("B", "b@example.com");
    await seedNetwork({ mailboxCount: 2 });
    const networkRouter = router();
    const now = new Date("2026-08-19T12:00:00.000Z");
    const firstA = await networkRouter.selectWarmupMailbox({
      customerTenantId: a.tenant.id,
      customerMailboxId: a.mailbox.id,
      requestKey: "a-1",
      now,
    });
    const firstB = await networkRouter.selectWarmupMailbox({
      customerTenantId: b.tenant.id,
      customerMailboxId: b.mailbox.id,
      requestKey: "b-1",
      now,
    });
    expect(firstA.selected?.networkMailboxId).toBe(firstB.selected?.networkMailboxId);
  });

  it("returns CUSTOMER_MAILBOX_DISCONNECTED for a disconnected customer mailbox", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com", "DISCONNECTED");
    await seedNetwork({ mailboxCount: 1 });
    const result = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "disc",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(result.decision.outcome).toBe("CUSTOMER_MAILBOX_DISCONNECTED");
    expect(result.failureClass).toBe("PERMANENT");
    expect(result.selected).toBeUndefined();
  });

  it("does not double-consume capacity when the same request key is selected concurrently", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    await seedNetwork({ mailboxCount: 1, mailboxCapacity: 10 });
    const networkRouter = router();
    const now = new Date("2026-08-19T12:00:00.000Z");
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        networkRouter.selectWarmupMailbox({
          customerTenantId: tenant.id,
          customerMailboxId: mailbox.id,
          requestKey: "same-concurrent-key",
          now,
        }),
      ),
    );
    const ids = new Set(results.map((result) => result.decision.id));
    expect(ids.size).toBe(1);
    expect(results.every((result) => result.decision.outcome === "SELECTED")).toBe(true);
    const usage = await handle.database.query<{ usage_count: number }>(`SELECT usage_count FROM warmup_network_mailboxes`);
    expect(usage[0]?.usage_count).toBe(1);
  });

  it("treats a quarantined partner as permanently ineligible", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    await seedNetwork({ mailboxCount: 1 });
    await handle.database.query(`UPDATE warmup_network_mailboxes SET status = 'QUARANTINED'`);
    const result = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "quarantine",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(result.decision.outcome).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(result.failureClass).toBe("PERMANENT");
    expect(readCounter(METRIC.warmupNetworkRouteQuarantined)).toBeGreaterThanOrEqual(1);
  });

  it("treats a disabled network, missing credential, and low health as ineligible", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    await seedNetwork({ mailboxCount: 1 });
    await handle.database.query(`UPDATE warmup_networks SET status = 'DISABLED'`);
    const disabled = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "disabled-net",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(disabled.decision.outcome).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(disabled.failureClass).toBe("PERMANENT");

    await handle.database.query(`UPDATE warmup_networks SET status = 'ACTIVE'`);
    await handle.database.query(`UPDATE warmup_network_mailboxes SET credential_available = false`);
    const creds = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "no-cred",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(creds.decision.outcome).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(creds.failureClass).toBe("PERMANENT");

    await handle.database.query(`UPDATE warmup_network_mailboxes SET credential_available = true, health_score = 1`);
    const health = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "low-health",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(health.decision.outcome).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(health.failureClass).toBe("PERMANENT");
  });

  it("selects a domain only as a consequence of selecting that domain's mailbox", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    const seeded = await seedNetwork({ mailboxCount: 2, secondDomain: true });
    const result = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "cross-domain",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(result.decision.outcome).toBe("SELECTED");
    const picked = seeded.networkMailboxes.find((row) => row.id === result.selected?.networkMailboxId);
    expect(picked?.domain_id).toBe(result.selected?.domainId);
  });

  it("returns NO_ELIGIBLE_WARMUP_MAILBOX when the pool is empty", async () => {
    const { mailbox, tenant } = await seedCustomer("Cust", "cust@example.com");
    const result = await router().selectWarmupMailbox({
      customerTenantId: tenant.id,
      customerMailboxId: mailbox.id,
      requestKey: "empty",
      now: new Date("2026-08-19T12:00:00.000Z"),
    });
    expect(result.decision.outcome).toBe("NO_ELIGIBLE_WARMUP_MAILBOX");
    expect(result.decision.reason).toBe("EMPTY_POOL");
    expect(result.failureClass).toBe("PERMANENT");
  });
});

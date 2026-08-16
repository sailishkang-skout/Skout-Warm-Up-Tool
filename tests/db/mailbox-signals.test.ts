/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real signal persistence layer — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresMailboxSignalRepository } from "../../src/modules/health/infrastructure/postgres-mailbox-signal-repository.js";
import type { Signal } from "../../src/modules/health/domain/signal.js";
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

async function createTenantAndMailbox(emailAddress = "signals@example.com") {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Signal Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress,
    provider: "GMAIL",
  });
  return { tenant, mailbox };
}

const SIGNAL: Signal = {
  type: "PROVIDER_CONNECTED",
  value: true,
  evidence: { source: "mailbox.status", observedAt: new Date(), confidence: "HIGH", metadata: { mailboxStatus: "CONNECTED" } },
};

describe("PostgresMailboxSignalRepository", () => {
  it("records and retrieves signals for a mailbox", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxSignalRepository(handle.database);

    await repository.record(tenant.id, mailbox.id, [SIGNAL]);
    const signals = await repository.listByMailbox(tenant.id, mailbox.id);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: "PROVIDER_CONNECTED", value: true });
    expect(signals[0]?.evidence.confidence).toBe("HIGH");
    expect(signals[0]?.evidence.metadata).toEqual({ mailboxStatus: "CONNECTED" });
  });

  it("records multiple signals from one collection in a single call", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxSignalRepository(handle.database);
    const signals: Signal[] = [
      SIGNAL,
      { type: "SEND_CAPABLE", value: true, evidence: { source: "test", observedAt: new Date(), confidence: "HIGH" } },
      { type: "DOMAIN_MX", value: "PASS", evidence: { source: "test", observedAt: new Date(), confidence: "HIGH" } },
    ];

    await repository.record(tenant.id, mailbox.id, signals);
    const stored = await repository.listByMailbox(tenant.id, mailbox.id);
    expect(stored).toHaveLength(3);
  });

  it("orders results newest first", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxSignalRepository(handle.database);
    const older: Signal = { ...SIGNAL, value: false, evidence: { ...SIGNAL.evidence, observedAt: new Date(Date.now() - 60_000) } };
    const newer: Signal = { ...SIGNAL, value: true, evidence: { ...SIGNAL.evidence, observedAt: new Date() } };

    await repository.record(tenant.id, mailbox.id, [older]);
    await repository.record(tenant.id, mailbox.id, [newer]);

    const signals = await repository.listByMailbox(tenant.id, mailbox.id);
    expect(signals[0]?.value).toBe(true);
    expect(signals[1]?.value).toBe(false);
  });

  it("enforces tenant isolation — tenant B never sees tenant A's signals", async () => {
    const { tenant: tenantA, mailbox: mailboxA } = await createTenantAndMailbox("a@example.com");
    const tenantB = await new PostgresTenantRepository(handle.database).create({ name: "Tenant B" });
    const repository = new PostgresMailboxSignalRepository(handle.database);

    await repository.record(tenantA.id, mailboxA.id, [SIGNAL]);

    await expect(repository.listByMailbox(tenantB.id, mailboxA.id)).resolves.toEqual([]);
  });

  it("never persists a credential/token-shaped value in the signal payload", async () => {
    const { tenant, mailbox } = await createTenantAndMailbox();
    const repository = new PostgresMailboxSignalRepository(handle.database);
    await repository.record(tenant.id, mailbox.id, [SIGNAL]);

    const rows = await handle.database.query<{ value: unknown; metadata: unknown }>(
      "SELECT value, metadata FROM mailbox_signals",
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password/i);
  });
});

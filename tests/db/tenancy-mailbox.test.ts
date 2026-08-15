/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`, which
 * expects `docker compose up -d postgres` (or an equivalent Postgres
 * reachable at TEST_DATABASE_URL) to already be running. This suite runs
 * real repositories against real Postgres — no mocked SQL behavior.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { ConflictError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { asTenantId } from "../../src/shared/types/index.js";
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
  // Guards against beforeAll having failed before `handle` was assigned —
  // otherwise a database-unavailable failure gets masked by a confusing
  // "Cannot read properties of undefined" from this hook instead.
  if (handle) {
    await handle.database.close();
  }
});

describe("PostgresTenantRepository", () => {
  it("creates a tenant with defaults applied", async () => {
    const repo = new PostgresTenantRepository(handle.database);
    const tenant = await repo.create({ name: "Acme Inc" });

    expect(tenant.name).toBe("Acme Inc");
    expect(tenant.status).toBe("ACTIVE");
    expect(tenant.createdAt).toBeInstanceOf(Date);
    expect(tenant.updatedAt).toBeInstanceOf(Date);
  });

  it("finds a tenant by id", async () => {
    const repo = new PostgresTenantRepository(handle.database);
    const created = await repo.create({ name: "Acme Inc" });

    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("returns undefined for a nonexistent tenant id", async () => {
    const repo = new PostgresTenantRepository(handle.database);
    expect(await repo.findById(asTenantId(randomUUID()))).toBeUndefined();
  });
});

describe("PostgresMailboxRepository", () => {
  it("creates a mailbox linked to its tenant", async () => {
    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    const tenant = await tenantRepo.create({ name: "Acme Inc" });

    const mailbox = await mailboxRepo.create({
      tenantId: tenant.id,
      emailAddress: "Warmup.User@Example.com",
      provider: "GMAIL",
    });

    expect(mailbox.tenantId).toBe(tenant.id);
    expect(mailbox.emailAddress).toBe("Warmup.User@Example.com");
    expect(mailbox.emailAddressCanonical).toBe("warmup.user@example.com");
    expect(mailbox.status).toBe("NEW");
  });

  it("lists mailboxes by tenant, and enforces tenant isolation on findById", async () => {
    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    const tenantA = await tenantRepo.create({ name: "Tenant A" });
    const tenantB = await tenantRepo.create({ name: "Tenant B" });
    const mailboxA = await mailboxRepo.create({
      tenantId: tenantA.id,
      emailAddress: "a@example.com",
      provider: "GMAIL",
    });

    const listedForA = await mailboxRepo.listByTenant(tenantA.id);
    expect(listedForA.map((m) => m.id)).toEqual([mailboxA.id]);

    const listedForB = await mailboxRepo.listByTenant(tenantB.id);
    expect(listedForB).toEqual([]);

    // Tenant isolation: tenant B must never be able to fetch tenant A's mailbox by id.
    expect(await mailboxRepo.findById(tenantB.id, mailboxA.id)).toBeUndefined();
    expect(await mailboxRepo.findById(tenantA.id, mailboxA.id)).toEqual(mailboxA);
  });

  it("rejects a mailbox referencing a tenant that does not exist (foreign key)", async () => {
    const mailboxRepo = new PostgresMailboxRepository(handle.database);

    await expect(
      mailboxRepo.create({
        tenantId: asTenantId(randomUUID()),
        emailAddress: "orphan@example.com",
        provider: "GMAIL",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a duplicate canonical email address within the same tenant (unique constraint)", async () => {
    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    const tenant = await tenantRepo.create({ name: "Acme Inc" });

    await mailboxRepo.create({ tenantId: tenant.id, emailAddress: "dup@example.com", provider: "GMAIL" });

    // Case-different but canonicalizes to the same value — must still collide.
    await expect(
      mailboxRepo.create({ tenantId: tenant.id, emailAddress: "DUP@Example.com", provider: "MICROSOFT365" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same email address across different tenants", async () => {
    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    const tenantA = await tenantRepo.create({ name: "Tenant A" });
    const tenantB = await tenantRepo.create({ name: "Tenant B" });

    await mailboxRepo.create({ tenantId: tenantA.id, emailAddress: "shared@example.com", provider: "GMAIL" });
    const mailboxB = await mailboxRepo.create({
      tenantId: tenantB.id,
      emailAddress: "shared@example.com",
      provider: "GMAIL",
    });

    expect(mailboxB.tenantId).toBe(tenantB.id);
  });
});

describe("PostgresProviderAccountRepository", () => {
  it("creates a provider account linked to a mailbox and finds it back", async () => {
    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    const providerAccountRepo = new PostgresProviderAccountRepository(handle.database);
    const tenant = await tenantRepo.create({ name: "Acme Inc" });
    const mailbox = await mailboxRepo.create({
      tenantId: tenant.id,
      emailAddress: "warmup@example.com",
      provider: "GMAIL",
    });

    const account = await providerAccountRepo.create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      externalAccountRef: "google-sub-12345",
    });

    expect(account.status).toBe("PENDING");
    expect(account.externalAccountRef).toBe("google-sub-12345");
    expect(await providerAccountRepo.findByMailboxId(tenant.id, mailbox.id)).toEqual(account);
  });
});

describe("transactions", () => {
  it("commits everything written inside a successful transaction", async () => {
    const tenantId = await handle.database.withTransaction(async (tx) => {
      const tenantRepo = new PostgresTenantRepository(tx);
      const mailboxRepo = new PostgresMailboxRepository(tx);
      const tenant = await tenantRepo.create({ name: "Transactional Tenant" });
      await mailboxRepo.create({ tenantId: tenant.id, emailAddress: "tx@example.com", provider: "GMAIL" });
      return tenant.id;
    });

    const tenantRepo = new PostgresTenantRepository(handle.database);
    const mailboxRepo = new PostgresMailboxRepository(handle.database);
    expect(await tenantRepo.findById(tenantId)).toBeDefined();
    expect(await mailboxRepo.listByTenant(tenantId)).toHaveLength(1);
  });

  it("rolls back everything written when the transaction throws", async () => {
    let tenantIdFromFailedTx: string | undefined;

    await expect(
      handle.database.withTransaction(async (tx) => {
        const tenantRepo = new PostgresTenantRepository(tx);
        const tenant = await tenantRepo.create({ name: "Should Not Persist" });
        tenantIdFromFailedTx = tenant.id;
        throw new Error("deliberate failure to trigger rollback");
      }),
    ).rejects.toThrow("deliberate failure to trigger rollback");

    const tenantRepo = new PostgresTenantRepository(handle.database);
    expect(tenantIdFromFailedTx).toBeDefined();
    expect(await tenantRepo.findById(asTenantId(tenantIdFromFailedTx!))).toBeUndefined();
  });

  it("releases the connection back to the pool after commit and after rollback", async () => {
    const before = handle.database.getPoolStats();

    await handle.database.withTransaction(async (tx) => {
      const tenantRepo = new PostgresTenantRepository(tx);
      await tenantRepo.create({ name: "Pool Stats Commit" });
    });
    await expect(
      handle.database.withTransaction(async (tx) => {
        const tenantRepo = new PostgresTenantRepository(tx);
        await tenantRepo.create({ name: "Pool Stats Rollback" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = handle.database.getPoolStats();
    // No client left checked out: every connection the pool holds is idle.
    expect(after.idle).toBe(after.total);
    expect(after.total).toBeGreaterThanOrEqual(before.total);
  });
});

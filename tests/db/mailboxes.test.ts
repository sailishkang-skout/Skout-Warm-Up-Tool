/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * real mailbox/provider-account persistence, constraints, and the full
 * (still-unconfigured) connection lifecycle — no mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
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
import { ConflictError, ProviderError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { asMailboxId } from "../../src/shared/types/index.js";
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
  if (handle) {
    await handle.database.close();
  }
});

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

async function createTenant(name = "Acme Inc") {
  return new PostgresTenantRepository(handle.database).create({ name });
}

describe("mailbox creation and persistence", () => {
  it("creates a mailbox in PENDING status, enabled, with its provider account", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();

    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "warmup@example.com",
      provider: "GMAIL",
    });

    expect(mailbox.status).toBe("PENDING");
    expect(mailbox.enabled).toBe(true);
    expect(mailbox.tenantId).toBe(tenant.id);

    const providerAccountRepository = new PostgresProviderAccountRepository(handle.database);
    const providerAccount = await providerAccountRepository.findByMailboxId(tenant.id, mailbox.id);
    expect(providerAccount).toBeDefined();
    expect(providerAccount?.provider).toBe("GMAIL");
    expect(providerAccount?.status).toBe("PENDING");
  });

  it("persists an optional displayName", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();

    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "display@example.com",
      provider: "SMTP_IMAP",
      displayName: "Warmup Bot",
    });

    expect(mailbox.displayName).toBe("Warmup Bot");
  });

  it("rejects a duplicate mailbox (same canonical email) within the same tenant", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    await mailboxService.createMailbox(tenant.id, { emailAddress: "dup@example.com", provider: "GMAIL" });

    await expect(
      mailboxService.createMailbox(tenant.id, { emailAddress: "DUP@Example.com", provider: "MICROSOFT365" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows the same email address across different tenants", async () => {
    const mailboxService = buildMailboxService();
    const tenantA = await createTenant("Tenant A");
    const tenantB = await createTenant("Tenant B");
    await mailboxService.createMailbox(tenantA.id, { emailAddress: "shared@example.com", provider: "GMAIL" });

    const mailboxB = await mailboxService.createMailbox(tenantB.id, {
      emailAddress: "shared@example.com",
      provider: "GMAIL",
    });
    expect(mailboxB.tenantId).toBe(tenantB.id);
  });
});

describe("tenant isolation", () => {
  it("cannot retrieve another tenant's mailbox", async () => {
    const mailboxService = buildMailboxService();
    const tenantA = await createTenant("Tenant A");
    const tenantB = await createTenant("Tenant B");
    const mailboxA = await mailboxService.createMailbox(tenantA.id, {
      emailAddress: "a@example.com",
      provider: "GMAIL",
    });

    await expect(mailboxService.getMailbox(tenantB.id, mailboxA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("listMailboxes never crosses tenants", async () => {
    const mailboxService = buildMailboxService();
    const tenantA = await createTenant("Tenant A");
    const tenantB = await createTenant("Tenant B");
    await mailboxService.createMailbox(tenantA.id, { emailAddress: "a@example.com", provider: "GMAIL" });
    await mailboxService.createMailbox(tenantB.id, { emailAddress: "b@example.com", provider: "GMAIL" });

    expect(await mailboxService.listMailboxes(tenantA.id)).toHaveLength(1);
    expect(await mailboxService.listMailboxes(tenantB.id)).toHaveLength(1);
  });
});

describe("connection lifecycle (no adapter can validate for real)", () => {
  it("connect never reaches CONNECTED — it throws ProviderError and persists ERROR", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "connect@example.com",
      provider: "GMAIL",
    });

    await expect(mailboxService.connectMailbox(tenant.id, mailbox.id)).rejects.toBeInstanceOf(ProviderError);

    const reloaded = await mailboxService.getMailbox(tenant.id, mailbox.id);
    expect(reloaded.status).toBe("ERROR");
  });

  it("records the failed connection attempt on the provider account (status, lastCheckedAt, lastError)", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "recorded@example.com",
      provider: "SMTP_IMAP",
    });

    await expect(mailboxService.connectMailbox(tenant.id, mailbox.id)).rejects.toBeInstanceOf(ProviderError);

    const providerAccount = await new PostgresProviderAccountRepository(handle.database).findByMailboxId(
      tenant.id,
      mailbox.id,
    );
    expect(providerAccount?.status).toBe("ERROR");
    expect(providerAccount?.lastCheckedAt).toBeInstanceOf(Date);
    expect(providerAccount?.lastError).toContain("not yet implemented");
  });

  it("disconnect is idempotent — a second call on an already-disconnected mailbox is a no-op", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "disconnect@example.com",
      provider: "GMAIL",
    });
    await mailboxService.connectMailbox(tenant.id, mailbox.id).catch(() => undefined); // -> ERROR

    const first = await mailboxService.disconnectMailbox(tenant.id, mailbox.id);
    expect(first.status).toBe("DISCONNECTED");
    const second = await mailboxService.disconnectMailbox(tenant.id, mailbox.id);
    expect(second.status).toBe("DISCONNECTED");
  });

  it("enable/disable are idempotent and persist across reads", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "enable@example.com",
      provider: "GMAIL",
    });

    const disabled = await mailboxService.disableMailbox(tenant.id, mailbox.id);
    expect(disabled.enabled).toBe(false);
    const disabledAgain = await mailboxService.disableMailbox(tenant.id, mailbox.id);
    expect(disabledAgain.enabled).toBe(false);

    const reEnabled = await mailboxService.enableMailbox(tenant.id, mailbox.id);
    expect(reEnabled.enabled).toBe(true);

    const reloaded = await mailboxService.getMailbox(tenant.id, mailbox.id);
    expect(reloaded.enabled).toBe(true);
  });

  it("a mailbox can be enabled while DISCONNECTED — enabled and status are independent", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "orthogonal@example.com",
      provider: "GMAIL",
    });
    await mailboxService.connectMailbox(tenant.id, mailbox.id).catch(() => undefined); // -> ERROR
    await mailboxService.disconnectMailbox(tenant.id, mailbox.id); // -> DISCONNECTED

    const stillEnabled = await mailboxService.getMailbox(tenant.id, mailbox.id);
    expect(stillEnabled.status).toBe("DISCONNECTED");
    expect(stillEnabled.enabled).toBe(true);
  });

  it("getCapabilities reflects the mailbox's own provider type", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "caps@example.com",
      provider: "SMTP_IMAP",
    });

    const capabilities = await mailboxService.getCapabilities(tenant.id, mailbox.id);
    expect(capabilities).toMatchObject({ supportsSmtp: true, supportsImap: true, supportsOAuth: false });
  });

  it("getMailbox on a nonexistent id throws NotFoundError", async () => {
    const mailboxService = buildMailboxService();
    const tenant = await createTenant();
    await expect(
      mailboxService.getMailbox(tenant.id, asMailboxId("00000000-0000-0000-0000-000000000000")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

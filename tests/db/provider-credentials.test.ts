/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real encrypted credential store against real Postgres — no mocked SQL
 * or encryption behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { createPostgresProviderCredentialStore } from "../../src/modules/providers/infrastructure/postgres-provider-credential-store.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { CredentialError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { asProviderAccountId, type ProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const KEY_A = "provider-credentials-test-key-a-32chars!";
const KEY_B = "provider-credentials-test-key-b-32chars!";

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

async function createProviderAccount(): Promise<ProviderAccountId> {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Credential Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress: `cred-${Date.now()}@example.com`,
    provider: "GMAIL",
  });
  const account = await new PostgresProviderAccountRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    provider: "GMAIL",
  });
  return account.id;
}

function credentialFor(providerAccountId: ProviderAccountId, accessToken: string): ProviderCredential {
  return {
    providerAccountId,
    kind: "GOOGLE_OAUTH",
    secretData: { accessToken, refreshToken: "refresh-value" },
  };
}

describe("PostgresProviderCredentialStore", () => {
  it("round-trips a saved credential", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();

    await store.saveCredential(credentialFor(providerAccountId, "at-1"));
    const fetched = await store.getCredential(providerAccountId);

    expect(fetched?.secretData.accessToken).toBe("at-1");
    expect(fetched?.kind).toBe("GOOGLE_OAUTH");
  });

  it("returns undefined for a provider account with no credential", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();
    await expect(store.getCredential(providerAccountId)).resolves.toBeUndefined();
  });

  it("never persists the access/refresh token in plaintext", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();
    await store.saveCredential(credentialFor(providerAccountId, "plaintext-canary-value"));

    const rows = await handle.database.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM provider_credentials WHERE provider_account_id = $1",
      [providerAccountId],
    );
    expect(rows[0]?.encrypted_payload).not.toContain("plaintext-canary-value");
  });

  it("saveCredential supersedes the previous ACTIVE row rather than overwriting it — history is kept", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();

    await store.saveCredential(credentialFor(providerAccountId, "at-1"));
    await store.saveCredential(credentialFor(providerAccountId, "at-2"));

    const rows = await handle.database.query<{ status: string }>(
      "SELECT status FROM provider_credentials WHERE provider_account_id = $1 ORDER BY created_at",
      [providerAccountId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("REVOKED");
    expect(rows[1]?.status).toBe("ACTIVE");

    const fetched = await store.getCredential(providerAccountId);
    expect(fetched?.secretData.accessToken).toBe("at-2");
  });

  it("revokeCredential marks the row REVOKED without deleting it", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();
    await store.saveCredential(credentialFor(providerAccountId, "at-1"));

    await store.revokeCredential(providerAccountId);

    await expect(store.getCredential(providerAccountId)).resolves.toBeUndefined();
    const rows = await handle.database.query<{ status: string; revoked_at: Date | null }>(
      "SELECT status, revoked_at FROM provider_credentials WHERE provider_account_id = $1",
      [providerAccountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("REVOKED");
    expect(rows[0]?.revoked_at).toBeInstanceOf(Date);
  });

  it("treats an expired credential as unusable even though its status is still ACTIVE", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();
    await store.saveCredential({ ...credentialFor(providerAccountId, "at-1"), expiresAt: new Date(Date.now() - 1000) });

    await expect(store.getCredential(providerAccountId)).resolves.toBeUndefined();
    const rows = await handle.database.query<{ status: string }>(
      "SELECT status FROM provider_credentials WHERE provider_account_id = $1",
      [providerAccountId],
    );
    // Still ACTIVE in storage — read-time expiry, not a background sweep — but unusable to callers.
    expect(rows[0]?.status).toBe("ACTIVE");
  });

  it("cannot decrypt a credential encrypted under a different key", async () => {
    const storeA = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const storeB = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_B }], 1));
    const providerAccountId = await createProviderAccount();
    await storeA.saveCredential(credentialFor(providerAccountId, "at-1"));

    await expect(storeB.getCredential(providerAccountId)).rejects.toBeInstanceOf(CredentialError);
  });

  it("rejects a tampered ciphertext at read time", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const providerAccountId = await createProviderAccount();
    await store.saveCredential(credentialFor(providerAccountId, "at-1"));

    await handle.database.query(
      `UPDATE provider_credentials
       SET encrypted_payload = jsonb_set(encrypted_payload::jsonb, '{ciphertext}', '"dGFtcGVyZWQtZGF0YQ=="')::text
       WHERE provider_account_id = $1`,
      [providerAccountId],
    );

    await expect(store.getCredential(providerAccountId)).rejects.toBeInstanceOf(CredentialError);
  });

  it("does not delete rows for the same provider account across different accounts", async () => {
    const store = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: KEY_A }], 1));
    const accountOne = await createProviderAccount();
    const accountTwo = await createProviderAccount();
    await store.saveCredential(credentialFor(accountOne, "at-one"));
    await store.saveCredential(credentialFor(accountTwo, "at-two"));

    await store.revokeCredential(accountOne);

    await expect(store.getCredential(accountOne)).resolves.toBeUndefined();
    await expect(store.getCredential(accountTwo)).resolves.toMatchObject({ secretData: { accessToken: "at-two" } });
  });
});

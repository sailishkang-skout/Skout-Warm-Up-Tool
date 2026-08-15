/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * real credential persistence, constraints, and the audit recorder — no
 * mocked SQL behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { generateApiKey } from "../../src/modules/auth/domain/api-key.js";
import { hashApiKeySecret } from "../../src/modules/auth/domain/api-key-hash.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { ConflictError, NotFoundError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { asTenantId } from "../../src/shared/types/index.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const PEPPER = "test-pepper-value-with-enough-length-32";

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

function buildService() {
  const credentialRepository = new PostgresApiCredentialRepository(handle.database);
  const tenantRepository = new PostgresTenantRepository(handle.database);
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
  const credentialService = createApiCredentialService({ repository: credentialRepository, auditRecorder, pepper: PEPPER });
  return { credentialRepository, tenantRepository, auditRecorder, credentialService };
}

async function createTenant(tenantRepository: PostgresTenantRepository, name = "Acme Inc") {
  return tenantRepository.create({ name });
}

describe("credential creation and persistence", () => {
  it("creates a credential and persists it with the expected fields", async () => {
    const { credentialService, tenantRepository, credentialRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    const issued = await credentialService.issueCredential(tenant.id, { name: "CI key" });

    expect(issued.apiKey).toContain(issued.credential.keyPrefix);
    const found = await credentialRepository.findById(tenant.id, issued.credential.id);
    expect(found).toMatchObject({ name: "CI key", status: "ACTIVE", keyPrefix: issued.credential.keyPrefix });
  });

  it("stores only the hash — the plaintext secret never appears anywhere in the row", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    const issued = await credentialService.issueCredential(tenant.id, { name: "Hash-only check" });

    const rows = await handle.database.query<Record<string, unknown>>(
      "SELECT * FROM api_credentials WHERE id = $1",
      [issued.credential.id],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    const rawRowText = JSON.stringify(row);
    expect(rawRowText).not.toContain(issued.apiKey);
    // The secret portion is everything after the marker+prefix.
    const secret = issued.apiKey.slice(4 + issued.credential.keyPrefix.length);
    expect(rawRowText).not.toContain(secret);
    expect(row?.["key_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.["key_hash"]).toBe(hashApiKeySecret(secret, PEPPER));
  });

  it("rejects a credential referencing a tenant that does not exist (foreign key)", async () => {
    const { credentialRepository } = buildService();
    const generated = generateApiKey();

    await expect(
      credentialRepository.create({
        tenantId: asTenantId("00000000-0000-0000-0000-000000000000"),
        name: "Orphan",
        keyPrefix: generated.prefix,
        keyHash: hashApiKeySecret(generated.secret, PEPPER),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects two credentials with the same key_prefix (unique constraint)", async () => {
    const { credentialRepository, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);
    const generated = generateApiKey();

    await credentialRepository.create({
      tenantId: tenant.id,
      name: "First",
      keyPrefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.secret, PEPPER),
    });

    await expect(
      credentialRepository.create({
        tenantId: tenant.id,
        name: "Second, colliding prefix",
        keyPrefix: generated.prefix,
        keyHash: hashApiKeySecret("a-different-secret", PEPPER),
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("associates the credential with the correct tenant", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenantA = await createTenant(tenantRepository, "Tenant A");
    const tenantB = await createTenant(tenantRepository, "Tenant B");

    const issuedA = await credentialService.issueCredential(tenantA.id, { name: "A's key" });

    expect(issuedA.credential.tenantId).toBe(tenantA.id);
    expect(await credentialService.listCredentials(tenantB.id)).toEqual([]);
    expect(await credentialService.listCredentials(tenantA.id)).toHaveLength(1);
  });
});

describe("revocation", () => {
  it("marks a credential REVOKED and sets revokedAt", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);
    const issued = await credentialService.issueCredential(tenant.id, { name: "To be revoked" });

    const revoked = await credentialService.revokeCredential(tenant.id, issued.credential.id);

    expect(revoked.status).toBe("REVOKED");
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });

  it("throws NotFoundError revoking a credential that doesn't belong to the caller's tenant", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenantA = await createTenant(tenantRepository, "Tenant A");
    const tenantB = await createTenant(tenantRepository, "Tenant B");
    const issued = await credentialService.issueCredential(tenantA.id, { name: "A's key" });

    await expect(credentialService.revokeCredential(tenantB.id, issued.credential.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("expiration", () => {
  it("persists an expiresAt timestamp when provided", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

    const issued = await credentialService.issueCredential(tenant.id, { name: "Expiring key", expiresAt });

    expect(issued.credential.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("leaves expiresAt unset when not provided", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    const issued = await credentialService.issueCredential(tenant.id, { name: "No expiry" });

    expect(issued.credential.expiresAt).toBeUndefined();
  });
});

describe("rotation", () => {
  it("issues a new credential and leaves the old one ACTIVE", async () => {
    const { credentialService, tenantRepository, credentialRepository } = buildService();
    const tenant = await createTenant(tenantRepository);
    const original = await credentialService.issueCredential(tenant.id, { name: "Original" });

    const rotated = await credentialService.rotateCredential(tenant.id, original.credential.id);

    expect(rotated.credential.id).not.toBe(original.credential.id);
    expect(rotated.apiKey).not.toBe(original.apiKey);
    const stillThere = await credentialRepository.findById(tenant.id, original.credential.id);
    expect(stillThere?.status).toBe("ACTIVE");
  });

  it("records an API_KEY_ROTATED audit event linking old and new credential ids", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);
    const original = await credentialService.issueCredential(tenant.id, { name: "Original" });

    const rotated = await credentialService.rotateCredential(tenant.id, original.credential.id);

    const rows = await handle.database.query<{ metadata: { previousId?: string; newId?: string } }>(
      "SELECT metadata FROM audit_events WHERE event_type = 'API_KEY_ROTATED' AND tenant_id = $1",
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      previousId: original.credential.id,
      newId: rotated.credential.id,
    });
  });

  it("throws NotFoundError rotating a nonexistent credential", async () => {
    const { credentialService, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    await expect(
      credentialService.rotateCredential(tenant.id, asTenantId("00000000-0000-0000-0000-000000000000") as never),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("audit event recorder", () => {
  it("persists a real row queryable afterward", async () => {
    const { auditRecorder, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    await auditRecorder.record({
      tenantId: tenant.id,
      eventType: "TENANT_ACCESS_DENIED",
      actorType: "api_key",
      metadata: { reason: "test" },
    });

    const rows = await handle.database.query<{ event_type: string; tenant_id: string }>(
      "SELECT event_type, tenant_id FROM audit_events WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: "TENANT_ACCESS_DENIED", tenant_id: tenant.id });
  });

  it("redacts sensitive-looking metadata keys before persisting", async () => {
    const { auditRecorder, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    await auditRecorder.record({
      tenantId: tenant.id,
      eventType: "AUTHENTICATION_FAILURE",
      actorType: "api_key",
      metadata: { reason: "invalid_credential", apiKey: "swu_should_never_be_stored" },
    });

    const rows = await handle.database.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("swu_should_never_be_stored");
  });

  it("preserves id-shaped metadata keys (not secret-shaped) — regression guard for over-broad redaction", async () => {
    // sanitizeForLogging redacts any key *containing* "credential" (by
    // design — see api-credential-service.ts's `id`/`previousId`/`newId`
    // naming). This locks in that a plain id reference survives intact
    // while an actually-secret-shaped key next to it still gets redacted.
    const { auditRecorder, tenantRepository } = buildService();
    const tenant = await createTenant(tenantRepository);

    await auditRecorder.record({
      tenantId: tenant.id,
      eventType: "API_KEY_ROTATED",
      actorType: "api_key",
      metadata: { previousId: "11111111-1111-1111-1111-111111111111", secret: "must-not-survive" },
    });

    const rows = await handle.database.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(rows[0]?.metadata).toMatchObject({
      previousId: "11111111-1111-1111-1111-111111111111",
      secret: "[REDACTED]",
    });
  });
});

/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Builds the
 * real app wired to real repositories/services (see src/app.ts's
 * composition root) — the full authentication flow end to end, no mocked
 * SQL or auth behavior.
 */
import type { DestinationStream } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { hashApiKeySecret } from "../../src/modules/auth/domain/api-key-hash.js";
import { generateApiKey } from "../../src/modules/auth/domain/api-key.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
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

const testConfig = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };
const silentLogger = createLogger({ level: "silent", serviceName: testConfig.service.name, env: testConfig.env });

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, silentLogger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
});

afterAll(async () => {
  if (handle) {
    await handle.database.close();
  }
});

/** Mirrors what the bootstrap CLI does — the only sanctioned way to get a tenant's first credential. */
async function bootstrapTenantAndCredential(name: string) {
  const tenantRepository = new PostgresTenantRepository(handle.database);
  const credentialRepository = new PostgresApiCredentialRepository(handle.database);
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, silentLogger);
  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: testConfig.security.apiKeyPepper,
  });
  const tenant = await tenantRepository.create({ name });
  const issued = await credentialService.issueCredential(tenant.id, { name: "Test credential" });
  return { tenant, credential: issued.credential, apiKey: issued.apiKey };
}

function createCapturingDestination(): { destination: DestinationStream; text: () => string } {
  const lines: string[] = [];
  return {
    destination: { write: (msg: string) => lines.push(msg) },
    text: () => lines.join("\n"),
  };
}

describe("authentication — missing/malformed/invalid credentials", () => {
  it("rejects a request with no Authorization header", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({ method: "GET", url: "/api/v1/credentials" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTHENTICATION_ERROR" } });
    await app.close();
  });

  it("rejects a malformed Authorization header (not Bearer)", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an Authorization header that is 'Bearer' with no token", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: "Bearer " },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a well-formed but unknown key", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${generateApiKey().fullKey}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a revoked key", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { tenant, credential, apiKey } = await bootstrapTenantAndCredential("Revoked Co");
    await new PostgresApiCredentialRepository(handle.database).revoke(tenant.id, credential.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an expired key", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantRepository = new PostgresTenantRepository(handle.database);
    const credentialRepository = new PostgresApiCredentialRepository(handle.database);
    const tenant = await tenantRepository.create({ name: "Expired Co" });
    const generated = generateApiKey();
    await credentialRepository.create({
      tenantId: tenant.id,
      name: "Expired",
      keyPrefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.secret, testConfig.security.apiKeyPepper),
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${generated.fullKey}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a key belonging to a suspended tenant", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey, tenant } = await bootstrapTenantAndCredential("Suspend Me Co");
    await handle.database.query("UPDATE tenants SET status = 'SUSPENDED' WHERE id = $1", [tenant.id]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a key belonging to a deleted tenant", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey, tenant } = await bootstrapTenantAndCredential("Delete Me Co");
    await handle.database.query("UPDATE tenants SET status = 'DELETED' WHERE id = $1", [tenant.id]);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("authentication — valid credentials", () => {
  it("authenticates successfully", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Happy Path Co");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().credentials).toHaveLength(1);
    await app.close();
  });

  it("resolves tenant identity from the credential, ignoring any tenantId in the request body", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Real Tenant Co");
    const foreignTenantId = "11111111-1111-1111-1111-111111111111";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: "New key", tenantId: foreignTenantId },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const rows = await handle.database.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM api_credentials WHERE id = $1",
      [body.id],
    );
    expect(rows[0]?.tenant_id).toBe(tenant.id);
    expect(rows[0]?.tenant_id).not.toBe(foreignTenantId);
    await app.close();
  });

  it("returns the full API key exactly once on creation, with an explicit one-time warning", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Create Co");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: "New key" },
    });

    const body = response.json();
    expect(typeof body.apiKey).toBe("string");
    expect(body.apiKey.startsWith("swu_")).toBe(true);
    expect(body.warning).toMatch(/only time/i);
    await app.close();
  });

  it("never returns the secret or hash from the list endpoint", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("List Co");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const text = JSON.stringify(response.json());
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain(apiKey);
    await app.close();
  });

  it("rotate returns a new key once and revoke never returns a secret", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey, credential } = await bootstrapTenantAndCredential("Rotate Co");

    const rotateResponse = await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credential.id}/rotate`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(rotateResponse.statusCode).toBe(200);
    const rotateBody = rotateResponse.json();
    expect(rotateBody.apiKey).toBeDefined();
    expect(rotateBody.id).not.toBe(credential.id);

    const revokeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${credential.id}/revoke`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(revokeResponse.statusCode).toBe(200);
    const revokeBody = revokeResponse.json();
    expect(revokeBody.status).toBe("REVOKED");
    expect(JSON.stringify(revokeBody)).not.toContain("apiKey");
    await app.close();
  });
});

describe("tenant isolation — no cross-tenant access", () => {
  it("cannot rotate a credential belonging to a different tenant", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${tenantB.credential.id}/rotate`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("cannot revoke a credential belonging to a different tenant, and the target credential is left untouched", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/credentials/${tenantB.credential.id}/revoke`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });

    expect(response.statusCode).toBe(404);
    const stillActive = await new PostgresApiCredentialRepository(handle.database).findById(
      tenantB.tenant.id,
      tenantB.credential.id,
    );
    expect(stillActive?.status).toBe("ACTIVE");
    await app.close();
  });

  it("tenant A's credential list never includes tenant B's credentials", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    await bootstrapTenantAndCredential("Tenant B");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });

    const body = response.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].id).toBe(tenantA.credential.id);
    await app.close();
  });
});

describe("security — no secret leakage", () => {
  it("never logs the raw API key or Authorization header across valid, invalid, and creation requests", async () => {
    const { destination, text } = createCapturingDestination();
    const capturingLogger = createLogger({ level: "info", serviceName: "test", env: "test" }, destination);
    const app = await buildApp(testConfig, capturingLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Log Safety Co");

    await app.inject({ method: "GET", url: "/api/v1/credentials", headers: { authorization: `Bearer ${apiKey}` } });
    await app.inject({
      method: "GET",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${generateApiKey().fullKey}` },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/credentials",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: "New key for log check" },
    });
    const newKey = created.json().apiKey as string;

    const logText = text();
    expect(logText).not.toContain(apiKey);
    expect(logText).not.toContain(newKey);
    expect(logText).not.toContain(`Bearer ${apiKey}`);
    await app.close();
  });
});

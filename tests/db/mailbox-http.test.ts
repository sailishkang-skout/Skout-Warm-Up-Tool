/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Builds the
 * real app wired to real repositories/services (see src/app.ts's
 * composition root) — the full mailbox HTTP flow end to end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
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
  return { tenant, apiKey: issued.apiKey };
}

async function createMailboxViaApi(
  app: Awaited<ReturnType<typeof buildApp>>,
  apiKey: string,
  body: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/mailboxes",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: body,
  });
  return response;
}

describe("authentication required", () => {
  it("rejects an unauthenticated create request", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({ method: "POST", url: "/api/v1/mailboxes", payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an unauthenticated list request", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const response = await app.inject({ method: "GET", url: "/api/v1/mailboxes" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("mailbox creation and retrieval", () => {
  it("creates a mailbox starting in PENDING — never claims CONNECTED", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Create Co");

    const response = await createMailboxViaApi(app, apiKey, { emailAddress: "new@example.com", provider: "GMAIL" });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe("PENDING");
    expect(body.status).not.toBe("CONNECTED");
    expect(body.enabled).toBe(true);
    await app.close();
  });

  it("ignores a tenantId field in the body — the mailbox belongs to the authenticated tenant", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { tenant, apiKey } = await bootstrapTenantAndCredential("Real Tenant Co");
    const foreignTenantId = "11111111-1111-1111-1111-111111111111";

    const response = await createMailboxViaApi(app, apiKey, {
      emailAddress: "spoof@example.com",
      provider: "GMAIL",
      tenantId: foreignTenantId,
    });

    expect(response.statusCode).toBe(201);
    const rows = await handle.database.query<{ tenant_id: string }>("SELECT tenant_id FROM mailboxes WHERE id = $1", [
      response.json().id,
    ]);
    expect(rows[0]?.tenant_id).toBe(tenant.id);
    expect(rows[0]?.tenant_id).not.toBe(foreignTenantId);
    await app.close();
  });

  it("rejects an invalid provider value", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Validation Co");

    const response = await createMailboxViaApi(app, apiKey, { emailAddress: "x@example.com", provider: "AOL" });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("lists only the authenticated tenant's mailboxes", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("List Co");
    await createMailboxViaApi(app, apiKey, { emailAddress: "one@example.com", provider: "GMAIL" });
    await createMailboxViaApi(app, apiKey, { emailAddress: "two@example.com", provider: "SMTP_IMAP" });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mailboxes).toHaveLength(2);
    await app.close();
  });

  it("retrieves a single mailbox by id", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Get Co");
    const created = await createMailboxViaApi(app, apiKey, { emailAddress: "get@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${created.json().id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().emailAddress).toBe("get@example.com");
    await app.close();
  });

  it("returns 404 for a nonexistent mailbox id", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("NotFound Co");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/mailboxes/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("tenant isolation", () => {
  it("tenant A cannot retrieve tenant B's mailbox", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");
    const mailboxB = await createMailboxViaApi(app, tenantB.apiKey, { emailAddress: "b@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxB.json().id}`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("tenant A cannot connect tenant B's mailbox", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");
    const mailboxB = await createMailboxViaApi(app, tenantB.apiKey, { emailAddress: "b2@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxB.json().id}/connect`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("tenant A cannot disable tenant B's mailbox, and B's mailbox is left untouched", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const tenantA = await bootstrapTenantAndCredential("Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Tenant B");
    const mailboxB = await createMailboxViaApi(app, tenantB.apiKey, { emailAddress: "b3@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxB.json().id}/disable`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
    });
    expect(response.statusCode).toBe(404);

    const stillEnabled = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxB.json().id}`,
      headers: { authorization: `Bearer ${tenantB.apiKey}` },
    });
    expect(stillEnabled.json().enabled).toBe(true);
    await app.close();
  });
});

describe("connect/disconnect/enable/disable/capabilities", () => {
  it("connect never returns a fabricated CONNECTED mailbox — it returns a safe provider error and the mailbox lands in ERROR", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Connect Co");
    const created = await createMailboxViaApi(app, apiKey, { emailAddress: "connect@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${created.json().id}/connect`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "PROVIDER_ERROR" } });

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${created.json().id}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(reloaded.json().status).toBe("ERROR");
    expect(reloaded.json().status).not.toBe("CONNECTED");
    await app.close();
  });

  it("disconnect transitions ERROR -> DISCONNECTED and is idempotent", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Disconnect Co");
    const created = await createMailboxViaApi(app, apiKey, { emailAddress: "disc@example.com", provider: "GMAIL" });
    await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${created.json().id}/connect`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${created.json().id}/disconnect`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("DISCONNECTED");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${created.json().id}/disconnect`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("DISCONNECTED");
    await app.close();
  });

  it("enable/disable toggle and are idempotent", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Toggle Co");
    const created = await createMailboxViaApi(app, apiKey, { emailAddress: "toggle@example.com", provider: "GMAIL" });
    const mailboxId = created.json().id;

    const disable1 = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/disable`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(disable1.json().enabled).toBe(false);

    const disable2 = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/disable`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(disable2.statusCode).toBe(200);
    expect(disable2.json().enabled).toBe(false);

    const enable1 = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/enable`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(enable1.json().enabled).toBe(true);
    await app.close();
  });

  it("capabilities reflect the mailbox's provider type", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Capabilities Co");
    const created = await createMailboxViaApi(app, apiKey, {
      emailAddress: "caps@example.com",
      provider: "MICROSOFT365",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${created.json().id}/capabilities`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "MICROSOFT365",
      capabilities: { supportsOAuth: true, supportsFolders: true, supportsSmtp: false },
    });
    await app.close();
  });
});

describe("security — no secret/internal leakage", () => {
  it("mailbox responses never include internal error details or a stack trace on connect failure", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database);
    const { apiKey } = await bootstrapTenantAndCredential("Safe Error Co");
    const created = await createMailboxViaApi(app, apiKey, { emailAddress: "safe@example.com", provider: "GMAIL" });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${created.json().id}/connect`,
      headers: { authorization: `Bearer ${apiKey}` },
    });

    const text = JSON.stringify(response.json());
    expect(text).not.toContain("stack");
    expect(text).not.toContain("node_modules");
    await app.close();
  });
});

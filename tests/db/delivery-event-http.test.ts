/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the delivery-event ingestion HTTP endpoint through the real
 * composition root (real Postgres, real Redis, real auth).
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
import type { RedisClient } from "../../src/shared/redis/index.js";
import {
  createTestDatabaseHandle,
  createTestRedisHandle,
  ensureTestDatabaseExists,
  flushTestRedis,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const testConfig = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };
const silentLogger = createLogger({ level: "silent", serviceName: testConfig.service.name, env: testConfig.env });

let handle: TestDatabaseHandle;
let redis: RedisClient;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  redis = createTestRedisHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, silentLogger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
  await flushTestRedis(redis);
});

afterAll(async () => {
  if (handle) await handle.database.close();
  if (redis) redis.disconnect();
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

async function createMailbox(app: Awaited<ReturnType<typeof buildApp>>, apiKey: string, emailAddress: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/mailboxes",
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { emailAddress, provider: "GMAIL" },
  });
  return response.json().id as string;
}

describe("delivery-event ingestion HTTP endpoint", () => {
  it("POST /api/v1/internal/delivery-events requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      payload: { mailboxId: "00000000-0000-0000-0000-000000000000", provider: "GMAIL", eventType: "DELIVERED", observedAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("ingests a valid event and returns 201 with a safe response body", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Ingest Co");
    const mailboxId = await createMailbox(app, apiKey, "ingest@example.com");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { mailboxId, provider: "GMAIL", providerEventId: "http-evt-1", eventType: "DELIVERED", observedAt: new Date().toISOString() },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.eventType).toBe("DELIVERED");
    expect(body.wasNew).toBe(true);
    await app.close();
  });

  it("a duplicate providerEventId returns 200 with wasNew: false instead of creating a second event", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Dup Co");
    const mailboxId = await createMailbox(app, apiKey, "dup@example.com");
    const payload = { mailboxId, provider: "GMAIL", providerEventId: "http-evt-dup", eventType: "BOUNCED", observedAt: new Date().toISOString() };

    const first = await app.inject({ method: "POST", url: "/api/v1/internal/delivery-events", headers: { authorization: `Bearer ${apiKey}` }, payload });
    const second = await app.inject({ method: "POST", url: "/api/v1/internal/delivery-events", headers: { authorization: `Bearer ${apiKey}` }, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().wasNew).toBe(false);
    expect(second.json().id).toBe(first.json().id);
    await app.close();
  });

  it("rejects a malformed event with a 400/validation error and never persists it", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Malformed Co");
    const mailboxId = await createMailbox(app, apiKey, "malformed@example.com");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { mailboxId, provider: "GMAIL", eventType: "NOT_A_REAL_EVENT_TYPE", observedAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(400);

    const rows = await handle.database.query("SELECT COUNT(*)::text AS count FROM delivery_events WHERE mailbox_id = $1", [mailboxId]);
    expect((rows[0] as { count: string }).count).toBe("0");
    await app.close();
  });

  it("rejects a mailbox belonging to a different tenant with a 404, never leaking cross-tenant existence", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey: apiKeyA } = await bootstrapTenantAndCredential("Tenant A Co");
    const mailboxIdA = await createMailbox(app, apiKeyA, "a@example.com");
    const { apiKey: apiKeyB } = await bootstrapTenantAndCredential("Tenant B Co");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKeyB}` },
      payload: { mailboxId: mailboxIdA, provider: "GMAIL", eventType: "DELIVERED", observedAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("always uses the server-set INTERNAL_API source, never a client-supplied one — an attempted override is silently ignored", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Source Co");
    const mailboxId = await createMailbox(app, apiKey, "source@example.com");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { mailboxId, provider: "GMAIL", providerEventId: "src-1", eventType: "DELIVERED", observedAt: new Date().toISOString(), source: "WEBHOOK" },
    });
    expect(response.statusCode).toBe(201);

    const rows = await handle.database.query<{ source: string }>("SELECT source FROM delivery_events WHERE id = $1", [response.json().id]);
    expect(rows[0]?.source).toBe("INTERNAL_API");
    await app.close();
  });

  it("never trusts a client-supplied tenantId — the body has no tenantId field at all and any extra field is simply ignored", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("NoTenant Co");
    const mailboxId = await createMailbox(app, apiKey, "notenant@example.com");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { mailboxId, tenantId: "00000000-0000-0000-0000-000000000000", provider: "GMAIL", providerEventId: "notenant-1", eventType: "DELIVERED", observedAt: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("response body never leaks metadata, tokens, or raw provider payloads", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Safe Co");
    const mailboxId = await createMailbox(app, apiKey, "safe@example.com");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/internal/delivery-events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        mailboxId,
        provider: "GMAIL",
        providerEventId: "safe-1",
        eventType: "BOUNCED",
        observedAt: new Date().toISOString(),
        metadata: { accessToken: "should-never-appear", diagnosticCode: "5.1.1" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain("should-never-appear");
    expect(response.body).not.toMatch(/accessToken|refreshToken|Authorization/i);
    await app.close();
  });
});

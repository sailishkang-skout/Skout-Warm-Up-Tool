/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the Stage 9 warmup profile management API through the real
 * composition root (real Postgres, real Redis).
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

const VALID_PROFILE = {
  targetDailyVolume: 30,
  startingDailyVolume: 5,
  maximumDailyVolume: 50,
  rampStrategy: "STANDARD",
  riskTolerance: "MEDIUM",
};

describe("warmup profile management HTTP endpoints", () => {
  it("GET returns 404 before any profile is created", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Profile Get Co");
    const mailboxId = await createMailbox(app, apiKey, "get@example.com");

    const response = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("POST creates a profile, always inactive regardless of what the client sends", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Profile Create Co");
    const mailboxId = await createMailbox(app, apiKey, "create@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...VALID_PROFILE, active: true },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.targetDailyVolume).toBe(30);
    expect(body.rampStrategy).toBe("STANDARD");
    expect(body.active).toBe(false);

    const getResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(getResponse.json().active).toBe(false);

    await app.close();
  });

  it("a client cannot supply tenantId/mailboxId — the mailbox comes from the route, the tenant from auth", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const tenantA = await bootstrapTenantAndCredential("Tenant A Owns");
    const tenantB = await bootstrapTenantAndCredential("Tenant B Attacker");
    const mailboxId = await createMailbox(app, tenantA.apiKey, "owned@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${tenantB.apiKey}` },
      payload: { ...VALID_PROFILE, tenantId: tenantB.tenant.id, mailboxId },
    });
    // tenantB does not own this mailbox — ownership is enforced regardless of any body field.
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("rejects an invalid rampStrategy", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Invalid Strategy Co");
    const mailboxId = await createMailbox(app, apiKey, "invalid-strategy@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...VALID_PROFILE, rampStrategy: "TURBO" },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("rejects startingDailyVolume greater than targetDailyVolume", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Bad Bounds Co");
    const mailboxId = await createMailbox(app, apiKey, "bad-bounds@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...VALID_PROFILE, startingDailyVolume: 40, targetDailyVolume: 30 },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("rejects targetDailyVolume greater than maximumDailyVolume", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Bad Max Co");
    const mailboxId = await createMailbox(app, apiKey, "bad-max@example.com");

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { ...VALID_PROFILE, targetDailyVolume: 60, maximumDailyVolume: 50 },
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("a second POST for the same mailbox returns 409", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Duplicate Profile Co");
    const mailboxId = await createMailbox(app, apiKey, "dup@example.com");

    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` }, payload: VALID_PROFILE });
    const second = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` }, payload: VALID_PROFILE });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("PATCH partially updates the profile, leaving other fields untouched", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Patch Co");
    const mailboxId = await createMailbox(app, apiKey, "patch@example.com");
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` }, payload: VALID_PROFILE });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { riskTolerance: "LOW" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.riskTolerance).toBe("LOW");
    expect(body.rampStrategy).toBe("STANDARD");
    expect(body.targetDailyVolume).toBe(30);

    await app.close();
  });

  it("PATCH cannot set active — the field does not exist in the update schema at all", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Patch Active Co");
    const mailboxId = await createMailbox(app, apiKey, "patch-active@example.com");
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` }, payload: VALID_PROFILE });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { active: true, riskTolerance: "HIGH" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().active).toBe(false);

    await app.close();
  });

  it("PATCH with no recognized fields is rejected", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Empty Patch Co");
    const mailboxId = await createMailbox(app, apiKey, "empty-patch@example.com");
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${apiKey}` }, payload: VALID_PROFILE });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("PATCH before a profile exists returns a safe conflict, not a fabricated profile", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("No Profile Patch Co");
    const mailboxId = await createMailbox(app, apiKey, "no-profile-patch@example.com");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { riskTolerance: "LOW" },
    });
    expect(response.statusCode).toBe(409);

    await app.close();
  });

  it("tenant isolation: tenant A cannot read or modify tenant B's profile", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const tenantA = await bootstrapTenantAndCredential("Isolation Tenant A");
    const tenantB = await bootstrapTenantAndCredential("Isolation Tenant B");
    const mailboxId = await createMailbox(app, tenantB.apiKey, "isolated@example.com");
    await app.inject({ method: "POST", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${tenantB.apiKey}` }, payload: VALID_PROFILE });

    const getResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`, headers: { authorization: `Bearer ${tenantA.apiKey}` } });
    expect(getResponse.statusCode).toBe(404);

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/mailboxes/${mailboxId}/warmup/profile`,
      headers: { authorization: `Bearer ${tenantA.apiKey}` },
      payload: { riskTolerance: "LOW" },
    });
    expect(patchResponse.statusCode).toBe(404);

    await app.close();
  });

  it("rejects every profile endpoint without authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const fakeMailboxId = "00000000-0000-0000-0000-000000000000";

    const getResponse = await app.inject({ method: "GET", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup/profile` });
    expect(getResponse.statusCode).toBe(401);
    const postResponse = await app.inject({ method: "POST", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup/profile`, payload: VALID_PROFILE });
    expect(postResponse.statusCode).toBe(401);
    const patchResponse = await app.inject({ method: "PATCH", url: `/api/v1/mailboxes/${fakeMailboxId}/warmup/profile`, payload: { riskTolerance: "LOW" } });
    expect(patchResponse.statusCode).toBe(401);

    await app.close();
  });
});

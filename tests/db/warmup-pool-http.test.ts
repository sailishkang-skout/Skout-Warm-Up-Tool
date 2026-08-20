import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
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

async function bootstrap(name: string) {
  const tenantRepository = new PostgresTenantRepository(handle.database);
  const credentialRepository = new PostgresApiCredentialRepository(handle.database);
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, silentLogger);
  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: testConfig.security.apiKeyPepper,
  });
  const tenant = await tenantRepository.create({ name });
  const issued = await credentialService.issueCredential(tenant.id, { name: "Test" });
  return { tenant, apiKey: issued.apiKey };
}

describe("warmup pool HTTP", () => {
  it("requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({ method: "GET", url: "/api/v1/warmup/pools" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("creates and lists pools without credential fields", async () => {
    const { tenant, apiKey } = await bootstrap("Pool Reader");
    const mailbox = await new PostgresMailboxRepository(handle.database).create({
      tenantId: tenant.id,
      emailAddress: "pool@one.test",
      provider: "GMAIL",
      status: "CONNECTED",
    });
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const headers = { authorization: `Bearer ${apiKey}` };

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/warmup/pools",
      headers,
      payload: { name: "senders" },
    });
    expect(created.statusCode).toBe(201);
    const poolId = created.json().id as string;

    const listed = await app.inject({ method: "GET", url: "/api/v1/warmup/pools", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().pools).toHaveLength(1);

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/warmup/pools/${poolId}/mailboxes`,
      headers,
      payload: { mailboxId: mailbox.id },
    });
    expect(added.statusCode).toBe(201);

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/warmup/pools/${poolId}/mailboxes`,
      headers,
    });
    expect(members.statusCode).toBe(200);
    expect(JSON.stringify(members.json())).not.toMatch(/token|secret|password|encrypted/i);

    const health = await app.inject({
      method: "GET",
      url: `/api/v1/warmup/pools/${poolId}/health`,
      headers,
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().memberships).toBe(1);

    await app.close();
  });
});

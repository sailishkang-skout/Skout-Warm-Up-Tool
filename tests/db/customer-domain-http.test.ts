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

describe("customer domain HTTP", () => {
  it("creates a tenant-scoped domain and never marks it verified without DNS evidence", async () => {
    const tenantRepository = new PostgresTenantRepository(handle.database);
    const credentialRepository = new PostgresApiCredentialRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, silentLogger);
    const credentialService = createApiCredentialService({
      repository: credentialRepository,
      auditRecorder,
      pepper: testConfig.security.apiKeyPepper,
    });
    const tenant = await tenantRepository.create({ name: "Acme" });
    const other = await tenantRepository.create({ name: "Other" });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Test" });
    const otherKey = (await credentialService.issueCredential(other.id, { name: "Other" })).apiKey;
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/domains",
      headers: { authorization: `Bearer ${issued.apiKey}` },
      payload: { domainName: "acme.com", provider: "GMAIL" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().domain.verificationStatus).toBe("UNVERIFIED");
    expect(created.json().domain.status).toBe("DISCOVERED");
    const id = created.json().domain.id as string;

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/domains/${id}`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(hidden.statusCode).toBe(404);

    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/domains/${id}/verify`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
      payload: { mx: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().domain.verificationStatus).toBe("VERIFIED");
    await app.close();
  });
});

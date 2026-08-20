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

async function issueKeys() {
  const tenantRepository = new PostgresTenantRepository(handle.database);
  const credentialRepository = new PostgresApiCredentialRepository(handle.database);
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, silentLogger);
  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: testConfig.security.apiKeyPepper,
  });
  const tenant = await tenantRepository.create({ name: "Acme Live" });
  const other = await tenantRepository.create({ name: "Other Live" });
  const tenantKey = (await credentialService.issueCredential(tenant.id, { name: "Tenant" })).apiKey;
  const operatorKey = (await credentialService.issueCredential(tenant.id, { name: "Ops", privilege: "OPERATOR" })).apiKey;
  const otherKey = (await credentialService.issueCredential(other.id, { name: "Other" })).apiKey;
  return { tenant, tenantKey, operatorKey, otherKey };
}

describe("live mailbox infrastructure HTTP", () => {
  it("does not create a mailbox when Google/Microsoft directory APIs are NOT_CONFIGURED", async () => {
    const { tenantKey } = await issueKeys();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes/provision",
      headers: { authorization: `Bearer ${tenantKey}` },
      payload: {
        emailAddress: "managed@acme.com",
        provider: "GMAIL",
        idempotencyKey: "provision-key-12345",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providerResult).toBe("NOT_CONFIGURED");
    expect(response.json().mailboxId).toBe("");
    const mailboxes = await handle.database.query("SELECT id FROM mailboxes");
    expect(mailboxes).toHaveLength(0);
  });

  it("rejects fleet kill switches for tenant API keys and allows operator keys", async () => {
    const { tenantKey, operatorKey } = await issueKeys();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/operations/kill-switches",
      headers: { authorization: `Bearer ${tenantKey}` },
      payload: { scope: "GLOBAL", reason: "incident response" },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/operations/kill-switches",
      headers: { authorization: `Bearer ${operatorKey}` },
      payload: { scope: "GLOBAL", reason: "incident response" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().switch.scope).toBe("GLOBAL");
  });

  it("isolates organization provider accounts by tenant", async () => {
    const { tenantKey, otherKey } = await issueKeys();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/provider-accounts",
      headers: { authorization: `Bearer ${tenantKey}` },
      payload: { provider: "GMAIL", customerDomain: "acme.com" },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().providerAccount.id as string;
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/provider-accounts/${id}`,
      headers: { authorization: `Bearer ${otherKey}` },
    });
    expect(hidden.statusCode).toBe(404);
  });

  it("exposes provider capabilities without claiming directory production activation", async () => {
    const { tenantKey } = await issueKeys();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/providers",
      headers: { authorization: `Bearer ${tenantKey}` },
    });
    expect(response.statusCode).toBe(200);
    const google = response.json().providers.find((item: { type: string }) => item.type === "GMAIL");
    expect(google.directoryConfigurationStatus).toBe("NOT_CONFIGURED");
    expect(google.capabilities.canSend).toBe(true);
  });
});

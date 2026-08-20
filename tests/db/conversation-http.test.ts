import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildServices } from "../../src/composition/build-services.js";
import { asMailboxId } from "../../src/shared/types/index.js";
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

describe("conversation HTTP", () => {
  it("requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations?mailboxId=00000000-0000-0000-0000-000000000000",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for another tenant's conversation and lists messages in sent order", async () => {
    const a = await bootstrap("A");
    const b = await bootstrap("B");
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${a.apiKey}` },
      payload: { emailAddress: "a@skout.test", provider: "GMAIL" },
    });
    const mailboxId = asMailboxId(created.json().id as string);
    const { conversationService } = buildServices(testConfig, silentLogger, handle.database, redis);

    await conversationService.persistNormalized(a.tenant.id, mailboxId, {
      provider: "GMAIL",
      direction: "OUTBOUND",
      providerMessageId: "out-1",
      providerThreadId: "th",
      sender: "a@skout.test",
      recipients: ["a@skout.test"],
      sentAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const persist = await conversationService.persistNormalized(a.tenant.id, mailboxId, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "in-1",
      providerThreadId: "th",
      sender: "x@y.com",
      recipients: ["a@skout.test"],
      sentAt: new Date("2026-01-01T00:01:00.000Z"),
    });

    const denied = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(denied.statusCode).toBe(404);

    const owned = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}`,
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(owned.statusCode).toBe(200);

    const messages = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/messages`,
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages.map((row: { direction: string }) => row.direction)).toEqual(["OUTBOUND", "INBOUND"]);

    const deniedMessages = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/messages`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(deniedMessages.statusCode).toBe(404);

    const deniedPolicy = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/policy-signals`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(deniedPolicy.statusCode).toBe(404);

    const deniedClassifications = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/classifications`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(deniedClassifications.statusCode).toBe(404);

    const ownedClassifications = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/classifications`,
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(ownedClassifications.statusCode).toBe(200);
    expect(ownedClassifications.json().classifications).toHaveLength(2);

    const messageClassification = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persist.conversation.id}/messages/${persist.message.id}/classification`,
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(messageClassification.statusCode).toBe(200);
    expect(messageClassification.json().status).toBe("PENDING");
    await app.close();
  });
});

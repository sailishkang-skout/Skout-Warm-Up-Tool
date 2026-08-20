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

async function seedNetworkMailbox() {
  const operator = await new PostgresTenantRepository(handle.database).create({ name: "Network Ops" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: operator.id,
    emailAddress: "partner@skout-warmup.test",
    provider: "GMAIL",
    status: "CONNECTED",
  });
  const network = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_networks (name) VALUES ('skout-managed') RETURNING id`,
  );
  const pool = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_network_pools (network_id, name) VALUES ($1, 'default') RETURNING id`,
    [network[0]!.id],
  );
  const domain = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_network_domains (
       network_id, pool_id, domain, provider, status, authentication_status, spf_status, dkim_status, dmarc_status,
       reputation_status, health_score
     ) VALUES ($1, $2, 'skout-warmup.test', 'GMAIL', 'ACTIVE', 'PASS', 'PASS', 'PASS', 'PASS', 'HEALTHY', 88)
     RETURNING id`,
    [network[0]!.id, pool[0]!.id],
  );
  const networkMailbox = await handle.database.query<{ id: string }>(
    `INSERT INTO warmup_network_mailboxes (
       domain_id, pool_id, mailbox_id, provider, provider_mailbox_identifier, mailbox_address, status, health_score
     ) VALUES ($1, $2, $3, 'GMAIL', $4, $4, 'ACTIVE', 88)
     RETURNING id`,
    [domain[0]!.id, pool[0]!.id, mailbox.id, mailbox.emailAddressCanonical],
  );
  return { domainId: domain[0]!.id, mailboxId: networkMailbox[0]!.id };
}

describe("warmup network HTTP", () => {
  it("requires authentication", async () => {
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const response = await app.inject({ method: "GET", url: "/api/v1/warmup-network/domains" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("lists domains and mailboxes without credential fields", async () => {
    const { apiKey } = await bootstrap("Reader");
    const seeded = await seedNetworkMailbox();
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const headers = { authorization: `Bearer ${apiKey}` };

    const domains = await app.inject({ method: "GET", url: "/api/v1/warmup-network/domains", headers });
    expect(domains.statusCode).toBe(200);
    expect(domains.json().domains).toHaveLength(1);
    expect(JSON.stringify(domains.json())).not.toMatch(/token|secret|password|credential/i);

    const domain = await app.inject({
      method: "GET",
      url: `/api/v1/warmup-network/domains/${seeded.domainId}`,
      headers,
    });
    expect(domain.statusCode).toBe(200);
    expect(domain.json().domain).toBe("skout-warmup.test");

    const mailboxes = await app.inject({ method: "GET", url: "/api/v1/warmup-network/mailboxes", headers });
    expect(mailboxes.statusCode).toBe(200);
    expect(mailboxes.json().mailboxes[0].mailboxAddress).toBe("partner@skout-warmup.test");
    expect(mailboxes.json().mailboxes[0].credentialAvailable).toBe(true);
    expect(mailboxes.json().mailboxes[0]).not.toHaveProperty("accessToken");
    expect(JSON.stringify(mailboxes.json())).not.toMatch(/token|secret|password/i);

    const mailbox = await app.inject({
      method: "GET",
      url: `/api/v1/warmup-network/mailboxes/${seeded.mailboxId}`,
      headers,
    });
    expect(mailbox.statusCode).toBe(200);

    const health = await app.inject({ method: "GET", url: "/api/v1/warmup-network/health", headers });
    expect(health.statusCode).toBe(200);
    expect(health.json().mailboxes).toBe(1);
    expect(health.json().domains).toBe(1);

    await app.close();
  });

  it("does not expose tenant write APIs for the global partner pool", async () => {
    const { apiKey } = await bootstrap("Writer");
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const headers = { authorization: `Bearer ${apiKey}` };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/warmup-network/domains",
      headers,
      payload: { domain: "evil.test" },
    });
    expect([404, 405]).toContain(created.statusCode);
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/warmup-network/health",
      headers,
      payload: { status: "DISABLED" },
    });
    expect([404, 405]).toContain(patched.statusCode);
    await app.close();
  });
});

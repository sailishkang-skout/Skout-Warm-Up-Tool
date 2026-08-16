/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`
 * (`docker compose up -d` brings up both). Exercises the full Google OAuth
 * connection flow end to end through real HTTP, real Postgres (encrypted
 * credential storage), and real Redis (OAuth state + connection lock) — the
 * only thing mocked is the Google API itself (global `fetch`), per Stage 6
 * spec section 23: no real Google account is ever required.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const testConfig = {
  ...loadConfig({
    NODE_ENV: "test",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GOOGLE_REDIRECT_URI: "https://app.test/api/v1/oauth/google/callback",
  }),
  log: { level: "silent" as const },
};
const configWithoutGoogle = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };
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

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (handle) {
    await handle.database.close();
  }
  if (redis) {
    redis.disconnect();
  }
});

function stubGoogleFetch(options: {
  tokenResponse?: Record<string, unknown>;
  tokenStatus?: number;
  userinfoResponse?: Record<string, unknown>;
  userinfoStatus?: number;
}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = input.toString();
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify(options.tokenResponse ?? {}), { status: options.tokenStatus ?? 200 });
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return new Response(JSON.stringify(options.userinfoResponse ?? {}), { status: options.userinfoStatus ?? 200 });
    }
    throw new Error(`Unexpected fetch to ${url} in oauth-http.test.ts`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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

describe("Google OAuth connection flow", () => {
  it("connects a mailbox end to end: initiate -> callback -> CONNECTED, credential encrypted at rest", async () => {
    stubGoogleFetch({
      tokenResponse: { access_token: "live-access-token", refresh_token: "live-refresh-token", expires_in: 3600, scope: "email" },
      userinfoResponse: { email: "alice@example.com", name: "Alice" },
    });
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("OAuth Happy Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "alice@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const initiate = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/connect/google`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(initiate.statusCode).toBe(202);
    const authorizationUrl = new URL(initiate.json().authorizationUrl);
    const state = authorizationUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/google/callback?state=${encodeURIComponent(state)}&code=fake-auth-code`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({ status: "connected", mailboxId, provider: "GMAIL" });

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(reloaded.json().status).toBe("CONNECTED");

    // Encrypted at rest: the row exists, but neither the raw access token
    // nor the refresh token appears anywhere in its ciphertext column.
    const rows = await handle.database.query<{ encrypted_payload: string; status: string; encryption_version: number }>(
      "SELECT encrypted_payload, status, encryption_version FROM provider_credentials WHERE status = 'ACTIVE'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encryption_version).toBe(1);
    expect(rows[0]?.encrypted_payload).not.toContain("live-access-token");
    expect(rows[0]?.encrypted_payload).not.toContain("live-refresh-token");
    const payload = JSON.parse(rows[0]!.encrypted_payload);
    expect(payload).toHaveProperty("iv");
    expect(payload).toHaveProperty("authTag");
    expect(payload).toHaveProperty("ciphertext");

    await app.close();
  });

  it("rejects an identity mismatch, never connects the mailbox, and never stores a credential", async () => {
    stubGoogleFetch({
      tokenResponse: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "email" },
      userinfoResponse: { email: "someone-else@example.com" },
    });
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Mismatch Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "expected@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const initiate = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/connect/google`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const state = new URL(initiate.json().authorizationUrl).searchParams.get("state")!;

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/google/callback?state=${encodeURIComponent(state)}&code=fake-auth-code`,
    });
    expect(callback.statusCode).toBe(409);
    expect(callback.json()).toMatchObject({ error: { code: "PROVIDER_IDENTITY_MISMATCH" } });

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v1/mailboxes/${mailboxId}`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(reloaded.json().status).toBe("PENDING");
    expect(reloaded.json().status).not.toBe("CONNECTED");

    const rows = await handle.database.query("SELECT * FROM provider_credentials");
    expect(rows).toHaveLength(0);

    await app.close();
  });

  it("rejects a replayed state on the second callback attempt", async () => {
    stubGoogleFetch({
      tokenResponse: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "email" },
      userinfoResponse: { email: "replay@example.com" },
    });
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Replay Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "replay@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const initiate = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/connect/google`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const state = new URL(initiate.json().authorizationUrl).searchParams.get("state")!;
    const callbackUrl = `/api/v1/oauth/google/callback?state=${encodeURIComponent(state)}&code=fake-auth-code`;

    const first = await app.inject({ method: "GET", url: callbackUrl });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: callbackUrl });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ error: { code: "OAUTH_ERROR" } });

    await app.close();
  });

  it("rejects OAuth initiation when Google is not configured for this deployment", async () => {
    const app = await buildApp(configWithoutGoogle, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("Unconfigured Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "noconfig@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;

    const initiate = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/connect/google`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(initiate.statusCode).toBe(500);
    expect(initiate.json()).toMatchObject({ error: { code: "CONFIGURATION_ERROR" } });

    await app.close();
  });

  it("the OAuth callback response never contains the access token, refresh token, or authorization code", async () => {
    stubGoogleFetch({
      tokenResponse: { access_token: "must-not-leak-access", refresh_token: "must-not-leak-refresh", expires_in: 3600, scope: "email" },
      userinfoResponse: { email: "safe@example.com" },
    });
    const app = await buildApp(testConfig, silentLogger, handle.database, redis);
    const { apiKey } = await bootstrapTenantAndCredential("No Leak Co");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { emailAddress: "safe@example.com", provider: "GMAIL" },
    });
    const mailboxId = created.json().id;
    const initiate = await app.inject({
      method: "POST",
      url: `/api/v1/mailboxes/${mailboxId}/connect/google`,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const state = new URL(initiate.json().authorizationUrl).searchParams.get("state")!;

    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/oauth/google/callback?state=${encodeURIComponent(state)}&code=must-not-leak-code`,
    });

    const text = JSON.stringify(callback.json());
    expect(text).not.toContain("must-not-leak-access");
    expect(text).not.toContain("must-not-leak-refresh");
    expect(text).not.toContain("must-not-leak-code");
    expect(text).not.toContain("stack");

    await app.close();
  });
});

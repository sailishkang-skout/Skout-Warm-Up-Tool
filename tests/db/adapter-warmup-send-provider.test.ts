/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Exercises
 * the real Stage 9 send chain end-to-end: `AdapterWarmupSendProvider` →
 * `resolveFreshCredential` (real encrypted Postgres credential store) →
 * `ProviderRegistry` → `GmailAdapter.sendMessage` — only Gmail's own HTTP
 * API is mocked (`fetchImpl`), the same pattern gmail-adapter.test.ts uses.
 * No mocked SQL, encryption, or credential-resolution behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdapterWarmupSendProvider } from "../../src/modules/warmup/infrastructure/adapter-warmup-send-provider.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../../src/modules/providers/infrastructure/postgres-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { asWarmupSessionId } from "../../src/shared/types/index.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const ENCRYPTION_KEY = "adapter-warmup-send-provider-test-key-32c";

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
});

afterAll(async () => {
  if (handle) await handle.database.close();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function buildDeps(fetchImpl: typeof fetch) {
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
  const providerRegistry = createProviderRegistry();
  providerRegistry.register(new GmailAdapter({ config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb" }, fetchImpl }));
  const credentialStore = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: ENCRYPTION_KEY }], 1));
  const providerAccountRepository = new PostgresProviderAccountRepository(handle.database);

  const mailboxService = createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry,
    credentialStore,
    auditRecorder,
  });

  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Send Provider Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress: "sender@example.com",
    provider: "GMAIL",
  });
  const providerAccount = await providerAccountRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL" });
  await credentialStore.saveCredential({
    providerAccountId: providerAccount.id,
    kind: "GOOGLE_OAUTH",
    secretData: { accessToken: "valid-access-token", refreshToken: "refresh-value", accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString() },
  });

  const sendProvider = createAdapterWarmupSendProvider({ mailboxService, providerAccountRepository, credentialStore, providerRegistry, auditRecorder });
  const sessionId = asWarmupSessionId("11111111-1111-1111-1111-111111111111");
  const idempotencyKey = computeIdempotencyKey({ tenantId: tenant.id, sessionId, warmupDay: 1, executionSlot: 0 });

  return { tenant, mailbox, providerAccount, credentialStore, sendProvider, idempotencyKey, sessionId };
}

describe("AdapterWarmupSendProvider (end-to-end through a real GmailAdapter)", () => {
  it("sends through the real credential-resolution chain and returns ACCEPTED", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-msg-1" }));
    const { tenant, mailbox, sendProvider, idempotencyKey } = await buildDeps(fetchImpl);

    const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

    expect(result.status).toBe("ACCEPTED");
    expect(result.providerMessageId).toBe("gmail-msg-1");
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer valid-access-token");
  });

  it("self-sends — the generated message's recipient is the mailbox's own address", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-msg-2" }));
    const { tenant, mailbox, sendProvider, idempotencyKey } = await buildDeps(fetchImpl);

    await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse((requestInit.body as string)) as { raw: string };
    const decoded = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: sender@example.com");
    expect(decoded).toContain("From: sender@example.com");
  });

  it("refreshes a near-expired access token before sending, using the real resolveFreshCredential path", async () => {
    // Answers both the OAuth token-refresh call and the eventual send call
    // off the same fetchImpl, exactly as a real deployment's single
    // `fetch` would — proving resolveFreshCredential's refresh actually
    // happens before GmailAdapter.sendMessage runs, not instead of it.
    const combinedFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "refreshed-token", expires_in: 3600, scope: "openid" });
      }
      return jsonResponse({ id: "gmail-msg-3" });
    });
    const { tenant, mailbox, providerAccount, credentialStore, sendProvider, idempotencyKey } = await buildDeps(combinedFetch as unknown as typeof fetch);

    // Overwrite with a near-expiry credential so resolveFreshCredential decides to refresh.
    await credentialStore.saveCredential({
      providerAccountId: providerAccount.id,
      kind: "GOOGLE_OAUTH",
      secretData: { accessToken: "stale-token", refreshToken: "refresh-value", accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString() },
    });

    const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

    expect(result.status).toBe("ACCEPTED");
    const sendCall = combinedFetch.mock.calls.find(([url]) => !url.includes("oauth2.googleapis.com/token"));
    expect((sendCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({ Authorization: "Bearer refreshed-token" });

    const stored = await credentialStore.getCredential(providerAccount.id);
    expect(stored?.secretData.accessToken).toBe("refreshed-token");
  });

  it("returns AUTH_FAILED when no credential is stored for the mailbox", async () => {
    const fetchImpl = vi.fn();
    const { tenant, mailbox, providerAccount, credentialStore, sendProvider, idempotencyKey } = await buildDeps(fetchImpl);
    await credentialStore.revokeCredential(providerAccount.id);

    const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

    expect(result.status).toBe("AUTH_FAILED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never leaks the access token into the returned result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-msg-4" }));
    const { tenant, mailbox, sendProvider, idempotencyKey } = await buildDeps(fetchImpl);

    const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

    expect(JSON.stringify(result)).not.toContain("valid-access-token");
  });
});

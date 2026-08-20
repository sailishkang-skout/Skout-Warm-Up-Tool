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
import { createWarmupNetworkRouter } from "../../src/modules/warmup-network/application/warmup-network-router.js";
import { PostgresWarmupNetworkRepository } from "../../src/modules/warmup-network/infrastructure/postgres-warmup-network-repository.js";
import { loadConfig } from "../../src/shared/config/index.js";
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

  return {
    tenant,
    mailbox,
    providerAccount,
    credentialStore,
    providerAccountRepository,
    mailboxService,
    sendProvider,
    idempotencyKey,
    sessionId,
    auditRecorder,
  };
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

  describe("credential-refresh timeout (Stage 12.1)", () => {
    function timeoutError(): DOMException {
      return new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }

    async function withNearExpiryCredential(providerAccount: { id: import("../../src/shared/types/index.js").ProviderAccountId }, credentialStore: import("../../src/modules/providers/application/provider-credential-store.js").ProviderCredentialStore) {
      await credentialStore.saveCredential({
        providerAccountId: providerAccount.id,
        kind: "GOOGLE_OAUTH",
        secretData: { accessToken: "stale-token", refreshToken: "refresh-value", accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString() },
      });
    }

    it("a credential-refresh timeout produces a retryable TEMPORARY_FAILURE, never AUTH_FAILED, and never reaches the send endpoint", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          throw timeoutError();
        }
        return jsonResponse({ id: "should-never-be-called" });
      });
      const { tenant, mailbox, providerAccount, credentialStore, sendProvider, idempotencyKey } = await buildDeps(fetchImpl as unknown as typeof fetch);
      await withNearExpiryCredential(providerAccount, credentialStore);

      const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

      expect(result.status).toBe("TEMPORARY_FAILURE");
      expect(result.retryable).toBe(true);
      const sendCalls = fetchImpl.mock.calls.filter(([url]) => !(url as string).includes("oauth2.googleapis.com/token"));
      expect(sendCalls).toHaveLength(0); // no duplicate-send risk: never reached the provider
    });

    it("a credential-refresh timeout does NOT revoke the credential — the refresh token itself was never confirmed invalid", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
        return jsonResponse({ id: "unused" });
      });
      const { providerAccount, credentialStore, sendProvider, tenant, mailbox, idempotencyKey } = await buildDeps(fetchImpl as unknown as typeof fetch);
      await withNearExpiryCredential(providerAccount, credentialStore);

      await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

      const stored = await credentialStore.getCredential(providerAccount.id);
      expect(stored).toBeDefined();
      expect(stored?.secretData.refreshToken).toBe("refresh-value");
    });

    it("a genuine invalid_grant during refresh is still terminal: AUTH_FAILED, and the credential IS revoked (Stage 12.1 does not weaken this)", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) return jsonResponse({ error: "invalid_grant" }, 400);
        return jsonResponse({ id: "unused" });
      });
      const { providerAccount, credentialStore, sendProvider, tenant, mailbox, idempotencyKey } = await buildDeps(fetchImpl as unknown as typeof fetch);
      await withNearExpiryCredential(providerAccount, credentialStore);

      const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

      expect(result.status).toBe("AUTH_FAILED");
      expect(result.retryable).toBe(false);
      const stored = await credentialStore.getCredential(providerAccount.id);
      expect(stored).toBeUndefined();
    });

    it("a subsequent send succeeds normally after a prior timeout — no leaked state affects later calls", async () => {
      let tokenCallCount = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
          tokenCallCount += 1;
          if (tokenCallCount === 1) throw timeoutError();
          return jsonResponse({ access_token: "refreshed-after-timeout", expires_in: 3600 });
        }
        return jsonResponse({ id: "gmail-msg-retry" });
      });
      const { providerAccount, credentialStore, sendProvider, tenant, mailbox, idempotencyKey } = await buildDeps(fetchImpl as unknown as typeof fetch);
      await withNearExpiryCredential(providerAccount, credentialStore);

      const first = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });
      expect(first.status).toBe("TEMPORARY_FAILURE");

      const second = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });
      expect(second.status).toBe("ACCEPTED");
    });

    it("never leaks the refresh/access token into the timeout result", async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
        return jsonResponse({ id: "unused" });
      });
      const { providerAccount, credentialStore, sendProvider, tenant, mailbox, idempotencyKey } = await buildDeps(fetchImpl as unknown as typeof fetch);
      await withNearExpiryCredential(providerAccount, credentialStore);

      const result = await sendProvider.sendWarmupMessage({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL", volume: 1, idempotencyKey });

      expect(JSON.stringify(result)).not.toContain("refresh-value");
      expect(JSON.stringify(result)).not.toContain("stale-token");
    });
  });

  it("with routing mode require, sends to the selected network mailbox instead of self", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-network-1" }));
    const built = await buildDeps(fetchImpl);
    await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");

    const operator = await new PostgresTenantRepository(handle.database).create({ name: "Network Ops" });
    const partner = await new PostgresMailboxRepository(handle.database).create({
      tenantId: operator.id,
      emailAddress: "partner@skout-warmup.test",
      provider: "GMAIL",
      status: "CONNECTED",
    });
    const network = await handle.database.query<{ id: string }>(`INSERT INTO warmup_networks (name) VALUES ('skout-managed') RETURNING id`);
    const pool = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_pools (network_id, name) VALUES ($1, 'default') RETURNING id`,
      [network[0]!.id],
    );
    const domain = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_domains (
         network_id, pool_id, domain, provider, status, authentication_status, spf_status, dkim_status, dmarc_status,
         reputation_status, health_score
       ) VALUES ($1, $2, 'skout-warmup.test', 'GMAIL', 'ACTIVE', 'PASS', 'PASS', 'PASS', 'PASS', 'HEALTHY', 90)
       RETURNING id`,
      [network[0]!.id, pool[0]!.id],
    );
    await handle.database.query(
      `INSERT INTO warmup_network_mailboxes (
         domain_id, pool_id, mailbox_id, provider, provider_mailbox_identifier, mailbox_address, status, health_score
       ) VALUES ($1, $2, $3, 'GMAIL', $4, $4, 'ACTIVE', 90)`,
      [domain[0]!.id, pool[0]!.id, partner.id, partner.emailAddressCanonical],
    );

    const warmupNetworkRouter = createWarmupNetworkRouter({
      database: handle.database,
      mailboxService: createMailboxService({
        database: handle.database,
        mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
        providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
        providerRegistry: createProviderRegistry(),
        credentialStore: built.credentialStore,
        auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      }),
      repository: new PostgresWarmupNetworkRepository(handle.database),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      config: loadConfig({ NODE_ENV: "test" }).warmupNetwork,
    });

    const sendProvider = createAdapterWarmupSendProvider({
      mailboxService: createMailboxService({
        database: handle.database,
        mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
        providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
        providerRegistry: createProviderRegistry(),
        credentialStore: built.credentialStore,
        auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      }),
      providerAccountRepository: new PostgresProviderAccountRepository(handle.database),
      credentialStore: built.credentialStore,
      providerRegistry: (() => {
        const registry = createProviderRegistry();
        registry.register(
          new GmailAdapter({
            config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb" },
            fetchImpl,
          }),
        );
        return registry;
      })(),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      warmupNetworkRouter,
      warmupNetworkRoutingMode: "require",
    });

    const result = await sendProvider.sendWarmupMessage({
      tenantId: built.tenant.id,
      mailboxId: built.mailbox.id,
      provider: "GMAIL",
      volume: 1,
      idempotencyKey: built.idempotencyKey,
    });
    expect(result.status).toBe("ACCEPTED");
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string) as { raw: string };
    const decoded = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: partner@skout-warmup.test");
    expect(decoded).toContain("From: sender@example.com");
  });

  async function seedPartnerMailbox() {
    const operator = await new PostgresTenantRepository(handle.database).create({ name: "Network Ops Failures" });
    const partner = await new PostgresMailboxRepository(handle.database).create({
      tenantId: operator.id,
      emailAddress: "partner-fail@skout-warmup.test",
      provider: "GMAIL",
      status: "CONNECTED",
    });
    const network = await handle.database.query<{ id: string }>(`INSERT INTO warmup_networks (name) VALUES ('skout-managed-fail') RETURNING id`);
    const pool = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_pools (network_id, name) VALUES ($1, 'default') RETURNING id`,
      [network[0]!.id],
    );
    const domain = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_domains (
         network_id, pool_id, domain, provider, status, authentication_status, spf_status, dkim_status, dmarc_status,
         reputation_status, health_score
       ) VALUES ($1, $2, 'skout-warmup-fail.test', 'GMAIL', 'ACTIVE', 'PASS', 'PASS', 'PASS', 'PASS', 'HEALTHY', 90)
       RETURNING id`,
      [network[0]!.id, pool[0]!.id],
    );
    const networkMailbox = await handle.database.query<{ id: string }>(
      `INSERT INTO warmup_network_mailboxes (
         domain_id, pool_id, mailbox_id, provider, provider_mailbox_identifier, mailbox_address, status, health_score
       ) VALUES ($1, $2, $3, 'GMAIL', $4, $4, 'ACTIVE', 90)
       RETURNING id`,
      [domain[0]!.id, pool[0]!.id, partner.id, partner.emailAddressCanonical],
    );
    return networkMailbox[0]!.id;
  }

  function routedSendProvider(
    built: Awaited<ReturnType<typeof buildDeps>>,
    fetchImpl: typeof fetch,
    mode: "prefer" | "require",
  ) {
    return createAdapterWarmupSendProvider({
      mailboxService: built.mailboxService,
      providerAccountRepository: built.providerAccountRepository,
      credentialStore: built.credentialStore,
      providerRegistry: (() => {
        const registry = createProviderRegistry();
        registry.register(
          new GmailAdapter({
            config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb" },
            fetchImpl,
          }),
        );
        return registry;
      })(),
      auditRecorder: built.auditRecorder,
      warmupNetworkRouter: createWarmupNetworkRouter({
        database: handle.database,
        mailboxService: built.mailboxService,
        repository: new PostgresWarmupNetworkRepository(handle.database),
        auditRecorder: built.auditRecorder,
        config: loadConfig({ NODE_ENV: "test" }).warmupNetwork,
      }),
      warmupNetworkRoutingMode: mode,
    });
  }

  it("with routing mode prefer and an empty pool, self-sends", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-prefer-self" }));
    const built = await buildDeps(fetchImpl);
    await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");
    const sendProvider = routedSendProvider(built, fetchImpl, "prefer");
    const result = await sendProvider.sendWarmupMessage({
      tenantId: built.tenant.id,
      mailboxId: built.mailbox.id,
      provider: "GMAIL",
      volume: 1,
      idempotencyKey: built.idempotencyKey,
    });
    expect(result.status).toBe("ACCEPTED");
    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const decoded = Buffer.from((JSON.parse(requestInit.body as string) as { raw: string }).raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: sender@example.com");
  });

  it("with routing mode require and an empty pool, fails closed without sending", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "should-not-send" }));
    const built = await buildDeps(fetchImpl);
    await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");
    const sendProvider = routedSendProvider(built, fetchImpl, "require");
    const result = await sendProvider.sendWarmupMessage({
      tenantId: built.tenant.id,
      mailboxId: built.mailbox.id,
      provider: "GMAIL",
      volume: 1,
      idempotencyKey: built.idempotencyKey,
    });
    expect(result.status).toBe("PERMANENT_FAILURE");
    expect(result.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 429, 5xx, and network loss after a successful route without marking SENT", async () => {
    const cases: Array<{ fetchImpl: typeof fetch; status: string }> = [
      { fetchImpl: vi.fn().mockResolvedValue(new Response("rate", { status: 429 })), status: "RATE_LIMITED" },
      { fetchImpl: vi.fn().mockResolvedValue(new Response("boom", { status: 503 })), status: "TEMPORARY_FAILURE" },
      {
        fetchImpl: vi.fn().mockRejectedValue(new Error("socket hang up")) as unknown as typeof fetch,
        status: "SEND_UNKNOWN",
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      await truncateAppTables(handle.pool);
      const built = await buildDeps(testCase.fetchImpl);
      await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");
      await seedPartnerMailbox();
      const sendProvider = routedSendProvider(built, testCase.fetchImpl, "require");
      const result = await sendProvider.sendWarmupMessage({
        tenantId: built.tenant.id,
        mailboxId: built.mailbox.id,
        provider: "GMAIL",
        volume: 1,
        idempotencyKey: `${built.idempotencyKey}-${index}`,
      });
      expect(result.status).toBe(testCase.status);
      expect(result.status).not.toBe("ACCEPTED");
    }
  });

  it("does not mark a partner credential unavailable when the customer send is AUTH_FAILED", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const built = await buildDeps(fetchImpl);
    await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");
    await seedPartnerMailbox();
    const sendProvider = routedSendProvider(built, fetchImpl, "require");
    const result = await sendProvider.sendWarmupMessage({
      tenantId: built.tenant.id,
      mailboxId: built.mailbox.id,
      provider: "GMAIL",
      volume: 1,
      idempotencyKey: built.idempotencyKey,
    });
    expect(result.status).toBe("AUTH_FAILED");
    const rows = await handle.database.query<{ credential_available: boolean }>(
      `SELECT credential_available FROM warmup_network_mailboxes`,
    );
    expect(rows[0]?.credential_available).toBe(true);
  });

  it("maps warmup-network routing exceptions to TEMPORARY_FAILURE and does not self-send", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "should-not-send" }));
    const built = await buildDeps(fetchImpl);
    await new PostgresMailboxRepository(handle.database).updateStatus(built.tenant.id, built.mailbox.id, "CONNECTED");
    const sendProvider = createAdapterWarmupSendProvider({
      mailboxService: built.mailboxService,
      providerAccountRepository: built.providerAccountRepository,
      credentialStore: built.credentialStore,
      providerRegistry: (() => {
        const registry = createProviderRegistry();
        registry.register(
          new GmailAdapter({
            config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb" },
            fetchImpl,
          }),
        );
        return registry;
      })(),
      auditRecorder: built.auditRecorder,
      warmupNetworkRouter: {
        async selectWarmupMailbox() {
          throw new Error("routing transaction failed");
        },
        async recordSendAccepted() {},
        async recordAuthFailed() {},
      },
      warmupNetworkRoutingMode: "prefer",
    });
    const result = await sendProvider.sendWarmupMessage({
      tenantId: built.tenant.id,
      mailboxId: built.mailbox.id,
      provider: "GMAIL",
      volume: 1,
      idempotencyKey: built.idempotencyKey,
    });
    expect(result.status).toBe("TEMPORARY_FAILURE");
    expect(result.retryable).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

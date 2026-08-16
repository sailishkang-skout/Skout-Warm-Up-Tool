import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOAuthConnectionService } from "../../src/modules/oauth/application/oauth-connection-service.js";
import { createInMemoryOAuthConnectionLock } from "../../src/modules/oauth/infrastructure/in-memory-oauth-connection-lock.js";
import { createInMemoryOAuthStateStore } from "../../src/modules/oauth/infrastructure/in-memory-oauth-state-store.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import {
  ConfigurationError,
  NotFoundError,
  OAuthError,
  ProviderError,
  ProviderIdentityMismatchError,
  ValidationError,
} from "../../src/shared/errors/index.js";
import {
  asConnectionAttemptId,
  asMailboxId,
  asProviderAccountId,
  asTenantId,
  type MailboxId,
  type TenantId,
} from "../../src/shared/types/index.js";
import { createFakeAuditEventRecorder } from "../support/fake-audit-event-recorder.js";
import type { ConnectionAttemptRepository } from "../../src/modules/oauth/application/connection-attempt-repository.js";
import type { ConnectionAttempt, ConnectionAttemptStatus } from "../../src/modules/oauth/domain/connection-attempt.js";
import type { MailboxRepository } from "../../src/modules/mailbox/application/mailbox-repository.js";
import type { Mailbox } from "../../src/modules/mailbox/domain/mailbox.js";
import type { MailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import type { ProviderAccountRepository } from "../../src/modules/providers/application/provider-account-repository.js";
import type { ProviderAccount } from "../../src/modules/providers/domain/provider-account.js";
import type { ProviderAdapter, ProviderMailboxIdentity } from "../../src/modules/providers/domain/provider-adapter.js";
import type { OAuthTokenSet } from "../../src/modules/providers/domain/oauth-operations.js";

const TENANT_A = asTenantId("11111111-1111-1111-1111-111111111111");
const TENANT_B = asTenantId("99999999-9999-9999-9999-999999999999");
const MAILBOX_A = asMailboxId("22222222-2222-2222-2222-222222222222");
const MAILBOX_B = asMailboxId("88888888-8888-8888-8888-888888888888");
const PROVIDER_ACCOUNT_A = asProviderAccountId("33333333-3333-3333-3333-333333333333");
const PROVIDER_ACCOUNT_B = asProviderAccountId("77777777-7777-7777-7777-777777777777");

function makeMailbox(id: MailboxId, tenantId: TenantId, emailAddressCanonical: string): Mailbox {
  return {
    id,
    tenantId,
    emailAddress: emailAddressCanonical,
    emailAddressCanonical,
    provider: "GMAIL",
    status: "PENDING",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeFakeMailboxRepository(mailboxes: readonly Mailbox[]): MailboxRepository {
  return {
    async findById(tenantId, id) {
      return mailboxes.find((m) => m.tenantId === tenantId && m.id === id);
    },
    async listByTenant(tenantId) {
      return mailboxes.filter((m) => m.tenantId === tenantId);
    },
    async create() {
      throw new Error("not used in this test");
    },
    async updateStatus() {
      throw new Error("not used in this test");
    },
    async updateEnabled() {
      throw new Error("not used in this test");
    },
  };
}

function makeFakeProviderAccountRepository(accounts: readonly ProviderAccount[]): ProviderAccountRepository {
  return {
    async findByMailboxId(tenantId, mailboxId) {
      return accounts.find((a) => a.tenantId === tenantId && a.mailboxId === mailboxId);
    },
    async create() {
      throw new Error("not used in this test");
    },
    async updateConnectionOutcome() {
      throw new Error("not used in this test");
    },
  };
}

function makeFakeConnectionAttemptRepository(): ConnectionAttemptRepository & { readonly all: ConnectionAttempt[] } {
  const all: ConnectionAttempt[] = [];
  let counter = 0;
  return {
    all,
    async create(input) {
      const attempt: ConnectionAttempt = {
        id: asConnectionAttemptId(`attempt-${++counter}`),
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        provider: input.provider,
        status: "STARTED",
        startedAt: new Date(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };
      all.push(attempt);
      return attempt;
    },
    async updateStatus(id, input) {
      const index = all.findIndex((a) => a.id === id);
      if (index === -1) return undefined;
      const existing = all[index]!;
      const updated: ConnectionAttempt = {
        ...existing,
        status: input.status,
        ...(input.failureReason ? { failureReason: input.failureReason } : {}),
        ...(input.completed ? { completedAt: new Date() } : {}),
      };
      all[index] = updated;
      return updated;
    },
    async findActiveByMailbox(tenantId, mailboxId) {
      const active: ConnectionAttemptStatus[] = ["STARTED", "AUTHORIZED", "VALIDATING"];
      return [...all].reverse().find((a) => a.tenantId === tenantId && a.mailboxId === mailboxId && active.includes(a.status));
    },
  };
}

function makeFakeOAuthAdapter(): ProviderAdapter & {
  exchangeCodeForTokens: ReturnType<typeof vi.fn>;
  getMailboxIdentityMock: ReturnType<typeof vi.fn>;
} {
  const exchangeCodeForTokens = vi.fn<(request: { code: string; codeVerifier: string }) => Promise<OAuthTokenSet>>();
  const getMailboxIdentityMock = vi.fn<(credential: unknown) => Promise<ProviderMailboxIdentity>>();

  const adapter: ProviderAdapter & {
    exchangeCodeForTokens: typeof exchangeCodeForTokens;
    getMailboxIdentityMock: typeof getMailboxIdentityMock;
  } = {
    providerType: "GMAIL",
    getCapabilities: () => ({
      canSend: true,
      canReceive: true,
      supportsThreads: true,
      supportsFolders: false,
      supportsOAuth: true,
      supportsSmtp: false,
      supportsImap: false,
    }),
    getConfigurationStatus: () => "CONFIGURED",
    validateConnection: async () => ({ status: "VALID", message: "ok", checkedAt: new Date() }),
    getMailboxIdentity: (credential) => getMailboxIdentityMock(credential),
    getConnectionHealth: async () => ({ status: "HEALTHY", providerType: "GMAIL", checkedAt: new Date() }),
    oauth: {
      getAuthorizationUrl: ({ state }) => `https://accounts.google.com/fake-auth?state=${state}`,
      exchangeCodeForTokens: (request) => exchangeCodeForTokens(request),
      refreshAccessToken: async () => {
        throw new Error("not used in this test");
      },
    },
    exchangeCodeForTokens,
    getMailboxIdentityMock,
  };
  return adapter;
}

function makeFakeMailboxService(overrides: Partial<MailboxService> = {}): MailboxService {
  return {
    async createMailbox() {
      throw new Error("not used in this test");
    },
    async getMailbox() {
      throw new Error("not used in this test");
    },
    async listMailboxes() {
      throw new Error("not used in this test");
    },
    async connectMailbox(tenantId, mailboxId) {
      return makeMailbox(mailboxId, tenantId, "connected@example.com");
    },
    async disconnectMailbox() {
      throw new Error("not used in this test");
    },
    async enableMailbox() {
      throw new Error("not used in this test");
    },
    async disableMailbox() {
      throw new Error("not used in this test");
    },
    async getCapabilities() {
      throw new Error("not used in this test");
    },
    async getConnectionSnapshot() {
      throw new Error("not used in this test");
    },
    async getConnectionHealth() {
      throw new Error("not used in this test");
    },
    async getBaseline() {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

function validTokenSet(): OAuthTokenSet {
  return { accessToken: "access-token-value", refreshToken: "refresh-token-value", expiresAt: new Date(Date.now() + 3600_000), scope: "email" };
}

describe("OAuthConnectionService", () => {
  let mailboxA: Mailbox;
  let mailboxB: Mailbox;
  let mailboxRepository: MailboxRepository;
  let providerAccountRepository: ProviderAccountRepository;
  let connectionAttemptRepository: ReturnType<typeof makeFakeConnectionAttemptRepository>;
  let adapter: ReturnType<typeof makeFakeOAuthAdapter>;
  let credentialStore: ReturnType<typeof createInMemoryProviderCredentialStore>;
  let stateStore: ReturnType<typeof createInMemoryOAuthStateStore>;
  let connectionLock: ReturnType<typeof createInMemoryOAuthConnectionLock>;
  let auditRecorder: ReturnType<typeof createFakeAuditEventRecorder>;
  let mailboxService: MailboxService;

  function buildService(mailboxServiceOverrides: Partial<MailboxService> = {}) {
    mailboxService = makeFakeMailboxService(mailboxServiceOverrides);
    const providerRegistry = createProviderRegistry();
    providerRegistry.register(adapter);

    return createOAuthConnectionService({
      mailboxRepository,
      providerAccountRepository,
      providerRegistry,
      credentialStore,
      stateStore,
      connectionLock,
      connectionAttemptRepository,
      auditRecorder,
      mailboxService,
    });
  }

  beforeEach(() => {
    mailboxA = makeMailbox(MAILBOX_A, TENANT_A, "alice@example.com");
    mailboxB = makeMailbox(MAILBOX_B, TENANT_B, "bob@example.com");
    mailboxRepository = makeFakeMailboxRepository([mailboxA, mailboxB]);
    providerAccountRepository = makeFakeProviderAccountRepository([
      {
        id: PROVIDER_ACCOUNT_A,
        tenantId: TENANT_A,
        mailboxId: MAILBOX_A,
        provider: "GMAIL",
        status: "PENDING",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: PROVIDER_ACCOUNT_B,
        tenantId: TENANT_B,
        mailboxId: MAILBOX_B,
        provider: "GMAIL",
        status: "PENDING",
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    connectionAttemptRepository = makeFakeConnectionAttemptRepository();
    adapter = makeFakeOAuthAdapter();
    credentialStore = createInMemoryProviderCredentialStore({ isProduction: false });
    stateStore = createInMemoryOAuthStateStore();
    connectionLock = createInMemoryOAuthConnectionLock();
    auditRecorder = createFakeAuditEventRecorder();
  });

  describe("initiate", () => {
    it("returns an authorization URL and records MAILBOX_CONNECTION_STARTED", async () => {
      const service = buildService();
      const result = await service.initiate(TENANT_A, MAILBOX_A, "GMAIL");
      expect(result.authorizationUrl).toContain("https://accounts.google.com/fake-auth?state=");
      expect(auditRecorder.events.map((e) => e.eventType)).toContain("MAILBOX_CONNECTION_STARTED");
      expect(connectionAttemptRepository.all).toHaveLength(1);
      expect(connectionAttemptRepository.all[0]?.status).toBe("STARTED");
    });

    it("throws NotFoundError for an unknown mailbox", async () => {
      const service = buildService();
      await expect(service.initiate(TENANT_A, asMailboxId("00000000-0000-0000-0000-000000000000"), "GMAIL")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("throws NotFoundError (tenant isolation) when tenant B requests tenant A's mailbox", async () => {
      const service = buildService();
      await expect(service.initiate(TENANT_B, MAILBOX_A, "GMAIL")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws ValidationError when the mailbox's provider does not match the requested provider", async () => {
      const service = buildService();
      await expect(service.initiate(TENANT_A, MAILBOX_A, "MICROSOFT365")).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ConfigurationError when the adapter is not configured", async () => {
      adapter.getConfigurationStatus = () => "NOT_CONFIGURED";
      const service = buildService();
      await expect(service.initiate(TENANT_A, MAILBOX_A, "GMAIL")).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("refuses a second concurrent initiation for the same mailbox (abuse-protection lock)", async () => {
      const service = buildService();
      await service.initiate(TENANT_A, MAILBOX_A, "GMAIL");
      await expect(service.initiate(TENANT_A, MAILBOX_A, "GMAIL")).rejects.toBeInstanceOf(ValidationError);
    });

    it("keeps two different tenants' in-flight attempts fully independent", async () => {
      const service = buildService();
      await expect(service.initiate(TENANT_A, MAILBOX_A, "GMAIL")).resolves.toBeDefined();
      await expect(service.initiate(TENANT_B, MAILBOX_B, "GMAIL")).resolves.toBeDefined();
    });
  });

  describe("handleCallback", () => {
    async function initiateAndExtractState(service: ReturnType<typeof buildService>, tenantId: TenantId, mailboxId: MailboxId) {
      const { authorizationUrl } = await service.initiate(tenantId, mailboxId, "GMAIL");
      return new URL(authorizationUrl).searchParams.get("state")!;
    }

    it("rejects a callback with no state", async () => {
      const service = buildService();
      await expect(service.handleCallback("GMAIL", {})).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an unknown/forged state and records OAUTH_STATE_REPLAY_DETECTED", async () => {
      const service = buildService();
      await expect(service.handleCallback("GMAIL", { state: "forged-state", code: "c" })).rejects.toBeInstanceOf(OAuthError);
      expect(auditRecorder.events.map((e) => e.eventType)).toContain("OAUTH_STATE_REPLAY_DETECTED");
    });

    it("rejects a replayed (already-consumed) state — single-use enforcement", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: mailboxA.emailAddressCanonical });
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await service.handleCallback("GMAIL", { state, code: "auth-code" });
      await expect(service.handleCallback("GMAIL", { state, code: "auth-code" })).rejects.toBeInstanceOf(OAuthError);
    });

    it("rejects when the callback's provider segment does not match the provider bound in state", async () => {
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await expect(service.handleCallback("MICROSOFT365", { state, code: "auth-code" })).rejects.toBeInstanceOf(OAuthError);
      const failure = auditRecorder.events.find((e) => e.eventType === "MAILBOX_CONNECTION_FAILED");
      expect(failure?.metadata).toMatchObject({ reason: "provider_mismatch" });
    });

    it("rejects when the provider redirect carries an error parameter (user denied consent)", async () => {
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await expect(service.handleCallback("GMAIL", { state, error: "access_denied" })).rejects.toBeInstanceOf(OAuthError);
      const failure = auditRecorder.events.find((e) => e.eventType === "MAILBOX_CONNECTION_FAILED");
      expect(failure?.metadata).toMatchObject({ reason: "provider_denied" });
    });

    it("rejects and never stores a credential when the OAuth identity does not match the mailbox (mandatory invariant)", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: "someone-else@example.com" });
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await expect(service.handleCallback("GMAIL", { state, code: "auth-code" })).rejects.toBeInstanceOf(
        ProviderIdentityMismatchError,
      );
      await expect(credentialStore.getCredential(PROVIDER_ACCOUNT_A)).resolves.toBeUndefined();
      const failure = auditRecorder.events.find((e) => e.eventType === "MAILBOX_CONNECTION_FAILED");
      expect(failure?.metadata).toMatchObject({ reason: "identity_mismatch" });
    });

    it("propagates a token exchange failure and records it", async () => {
      adapter.exchangeCodeForTokens.mockRejectedValue(new OAuthError("Google rejected the authorization code exchange"));
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await expect(service.handleCallback("GMAIL", { state, code: "bad-code" })).rejects.toBeInstanceOf(OAuthError);
      const failure = auditRecorder.events.find((e) => e.eventType === "MAILBOX_CONNECTION_FAILED");
      expect(failure?.metadata).toMatchObject({ reason: "token_exchange_failed" });
    });

    it("on success: stores the credential, connects the mailbox, and records the full audit trail", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: mailboxA.emailAddressCanonical });
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      const result = await service.handleCallback("GMAIL", { state, code: "auth-code" });

      expect(result).toMatchObject({ mailboxId: MAILBOX_A, provider: "GMAIL" });
      await expect(credentialStore.getCredential(PROVIDER_ACCOUNT_A)).resolves.toMatchObject({ kind: "GOOGLE_OAUTH" });
      expect(auditRecorder.events.map((e) => e.eventType)).toEqual(
        expect.arrayContaining(["MAILBOX_CONNECTION_STARTED", "PROVIDER_CREDENTIAL_CREATED", "MAILBOX_CONNECTION_SUCCEEDED"]),
      );
      expect(connectionAttemptRepository.all.at(-1)?.status).toBe("SUCCEEDED");
    });

    it("releases the lock on success, allowing a fresh initiate afterward", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: mailboxA.emailAddressCanonical });
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);
      await service.handleCallback("GMAIL", { state, code: "auth-code" });

      await expect(service.initiate(TENANT_A, MAILBOX_A, "GMAIL")).resolves.toBeDefined();
    });

    it("propagates a final connection-validation failure from mailboxService.connectMailbox", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: mailboxA.emailAddressCanonical });
      const service = buildService({
        connectMailbox: async () => {
          throw new ProviderError("GMAIL", "provider rejected the connection", { retryable: true });
        },
      });
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);

      await expect(service.handleCallback("GMAIL", { state, code: "auth-code" })).rejects.toBeInstanceOf(ProviderError);
      const failure = auditRecorder.events.find((e) => e.eventType === "MAILBOX_CONNECTION_FAILED");
      expect(failure?.metadata).toMatchObject({ reason: "connection_validation_failed" });
      // The credential itself was genuinely obtained and identity-verified —
      // it stays stored even though this connection attempt failed at the
      // final provider-validation step (Stage 6 spec section 3: credential
      // and connection lifecycle are separate).
      await expect(credentialStore.getCredential(PROVIDER_ACCOUNT_A)).resolves.toBeDefined();
    });

    it("never puts a token or authorization code into any recorded audit event", async () => {
      adapter.exchangeCodeForTokens.mockResolvedValue(validTokenSet());
      adapter.getMailboxIdentityMock.mockResolvedValue({ emailAddress: mailboxA.emailAddressCanonical });
      const service = buildService();
      const state = await initiateAndExtractState(service, TENANT_A, MAILBOX_A);
      await service.handleCallback("GMAIL", { state, code: "auth-code-secret-value" });

      const serialized = JSON.stringify(auditRecorder.events);
      expect(serialized).not.toContain("access-token-value");
      expect(serialized).not.toContain("refresh-token-value");
      expect(serialized).not.toContain("auth-code-secret-value");
    });
  });
});

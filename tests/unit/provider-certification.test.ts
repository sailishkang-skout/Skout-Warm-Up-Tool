/**
 * Mocked-only — hardening spec Gap B section 8 ("Add mocked provider
 * certification tests"). No real network call, no real credential, no
 * live send is ever attempted here; `adapter.sendMessage` is a plain
 * `vi.fn()`. This proves `certifyProviderSend`'s own orchestration
 * (adapter resolution, credential resolution, message shape, fail-closed
 * behavior) — the real HTTP behavior of each adapter is already covered by
 * `tests/unit/gmail-adapter.test.ts` / `microsoft365-adapter.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { certifyProviderSend } from "../../src/modules/providers/application/provider-certification.js";
import type { ProviderAdapter } from "../../src/modules/providers/domain/provider-adapter.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";
import type { ProviderCredentialStore } from "../../src/modules/providers/application/provider-credential-store.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import type { AuditEventRecorder } from "../../src/modules/audit/application/audit-event-recorder.js";
import { PolicyError } from "../../src/shared/errors/index.js";
import { asProviderAccountId, asTenantId } from "../../src/shared/types/index.js";

function noopAuditRecorder(): AuditEventRecorder {
  return { async record() {} };
}

function credentialWithToken(accessToken: string): ProviderCredential {
  return {
    providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
    kind: "GOOGLE_OAUTH",
    secretData: { accessToken },
  };
}

function fakeCredentialStore(credential: ProviderCredential | undefined): ProviderCredentialStore {
  return {
    async getCredential() {
      return credential;
    },
    async saveCredential() {},
    async revokeCredential() {},
  };
}

function fakeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    providerType: "GMAIL",
    getCapabilities: () => ({ canSend: true, canReceive: true, supportsThreads: true, supportsFolders: false, supportsOAuth: true, supportsSmtp: false, supportsImap: false }),
    getConfigurationStatus: () => "CONFIGURED",
    async validateConnection() {
      throw new Error("not used");
    },
    async getMailboxIdentity() {
      throw new Error("not used");
    },
    async getConnectionHealth() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

const BASE_INPUT = {
  tenantId: asTenantId("22222222-2222-2222-2222-222222222222"),
  providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
  provider: "GMAIL" as const,
  fromAddress: "mailbox-under-test@example.com",
  recipientEmail: "certification-recipient@example.com",
};

describe("certifyProviderSend", () => {
  it("calls the real adapter.sendMessage with the resolved credential and the explicit recipient — never a hardcoded address", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: "ACCEPTED", retryable: false, providerMessageId: "cert-msg-1" });
    const registry = createProviderRegistry();
    registry.register(fakeAdapter({ sendMessage }));

    const result = await certifyProviderSend(
      { providerRegistry: registry, credentialStore: fakeCredentialStore(credentialWithToken("at")), auditRecorder: noopAuditRecorder() },
      BASE_INPUT,
    );

    expect(result.outcome.status).toBe("ACCEPTED");
    expect(result.provider).toBe("GMAIL");
    const [credentialArg, commandArg] = sendMessage.mock.calls[0] as [ProviderCredential, { from: string; to: string; subject: string; body: string }];
    expect(credentialArg.secretData.accessToken).toBe("at");
    expect(commandArg.to).toBe(BASE_INPUT.recipientEmail);
    expect(commandArg.from).toBe(BASE_INPUT.fromAddress);
    expect(commandArg.subject).toContain("certification");
  });

  it("throws PolicyError (fail-closed) when the adapter has no sendMessage capability — never fakes a send", async () => {
    const registry = createProviderRegistry();
    registry.register(fakeAdapter()); // sendMessage left undefined, like SmtpImapAdapter

    await expect(
      certifyProviderSend(
        { providerRegistry: registry, credentialStore: fakeCredentialStore(credentialWithToken("at")), auditRecorder: noopAuditRecorder() },
        BASE_INPUT,
      ),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("passes an undefined credential through honestly when none is stored — sendMessage itself reports AUTH_FAILED, this never fabricates one", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: "AUTH_FAILED", retryable: false, safeReason: "No credential is stored." });
    const registry = createProviderRegistry();
    registry.register(fakeAdapter({ sendMessage }));

    const result = await certifyProviderSend(
      { providerRegistry: registry, credentialStore: fakeCredentialStore(undefined), auditRecorder: noopAuditRecorder() },
      BASE_INPUT,
    );

    expect(result.outcome.status).toBe("AUTH_FAILED");
    const [credentialArg] = sendMessage.mock.calls[0] as [ProviderCredential | undefined];
    expect(credentialArg).toBeUndefined();
  });

  it("propagates SEND_UNKNOWN honestly — certification never guesses at an unconfirmed outcome", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: "SEND_UNKNOWN", retryable: false, safeReason: "Could not confirm receipt." });
    const registry = createProviderRegistry();
    registry.register(fakeAdapter({ sendMessage }));

    const result = await certifyProviderSend(
      { providerRegistry: registry, credentialStore: fakeCredentialStore(credentialWithToken("at")), auditRecorder: noopAuditRecorder() },
      BASE_INPUT,
    );

    expect(result.outcome.status).toBe("SEND_UNKNOWN");
  });

  it("never leaks the access token into the returned result", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ status: "ACCEPTED", retryable: false });
    const registry = createProviderRegistry();
    registry.register(fakeAdapter({ sendMessage }));

    const result = await certifyProviderSend(
      { providerRegistry: registry, credentialStore: fakeCredentialStore(credentialWithToken("super-secret-token")), auditRecorder: noopAuditRecorder() },
      BASE_INPUT,
    );

    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });
});

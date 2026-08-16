import { describe, expect, it } from "vitest";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { SmtpImapAdapter } from "../../src/modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { ProviderError } from "../../src/shared/errors/index.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderAdapter } from "../../src/modules/providers/domain/provider-adapter.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";

const ADAPTERS: Array<{ name: string; adapter: ProviderAdapter }> = [
  { name: "GmailAdapter", adapter: new GmailAdapter() },
  { name: "Microsoft365Adapter", adapter: new Microsoft365Adapter() },
  { name: "SmtpImapAdapter", adapter: new SmtpImapAdapter() },
];

const FAKE_CREDENTIAL: ProviderCredential = {
  providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
  kind: "oauth2",
  secretData: {},
};

describe.each(ADAPTERS)("$name", ({ adapter }) => {
  it("declares a providerType matching one of the known provider types", () => {
    expect(["GMAIL", "MICROSOFT365", "SMTP_IMAP"]).toContain(adapter.providerType);
  });

  it("reports NOT_CONFIGURED — no Stage 5 adapter has real configuration wired up", () => {
    expect(adapter.getConfigurationStatus()).toBe("NOT_CONFIGURED");
  });

  it("never returns VALID from validateConnection with no credential", async () => {
    const result = await adapter.validateConnection(undefined);
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(result.checkedAt).toBeInstanceOf(Date);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("never returns VALID from validateConnection even when a credential is supplied", async () => {
    const result = await adapter.validateConnection(FAKE_CREDENTIAL);
    expect(result.status).not.toBe("VALID");
  });

  it("getMailboxIdentity throws ProviderError rather than fabricating an identity", async () => {
    await expect(adapter.getMailboxIdentity(undefined)).rejects.toBeInstanceOf(ProviderError);
    await expect(adapter.getMailboxIdentity(undefined)).rejects.toMatchObject({ provider: adapter.providerType });
  });

  it("getConnectionHealth returns UNKNOWN rather than fabricating HEALTHY", async () => {
    const result = await adapter.getConnectionHealth(undefined);
    expect(result.status).toBe("UNKNOWN");
    expect(result.providerType).toBe(adapter.providerType);
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("capabilities are booleans for every declared field, with no unexpected extras", () => {
    const capabilities = adapter.getCapabilities();
    const expectedKeys = [
      "canSend",
      "canReceive",
      "supportsThreads",
      "supportsFolders",
      "supportsOAuth",
      "supportsSmtp",
      "supportsImap",
    ];
    expect(Object.keys(capabilities).sort()).toEqual(expectedKeys.sort());
    for (const key of expectedKeys) {
      expect(typeof capabilities[key as keyof typeof capabilities]).toBe("boolean");
    }
  });
});

describe("provider-specific capability declarations", () => {
  it("Gmail: OAuth-based, no native folders, no raw SMTP/IMAP", () => {
    const capabilities = new GmailAdapter().getCapabilities();
    expect(capabilities).toMatchObject({ supportsOAuth: true, supportsSmtp: false, supportsImap: false, supportsFolders: false });
  });

  it("Microsoft 365: OAuth-based, has folders, no raw SMTP/IMAP", () => {
    const capabilities = new Microsoft365Adapter().getCapabilities();
    expect(capabilities).toMatchObject({ supportsOAuth: true, supportsSmtp: false, supportsImap: false, supportsFolders: true });
  });

  it("SMTP/IMAP: no OAuth, speaks both protocols, no native threading", () => {
    const capabilities = new SmtpImapAdapter().getCapabilities();
    expect(capabilities).toMatchObject({ supportsOAuth: false, supportsSmtp: true, supportsImap: true, supportsThreads: false });
  });

  it("all three providers can send and receive in principle", () => {
    for (const { adapter } of ADAPTERS) {
      expect(adapter.getCapabilities().canSend).toBe(true);
      expect(adapter.getCapabilities().canReceive).toBe(true);
    }
  });
});

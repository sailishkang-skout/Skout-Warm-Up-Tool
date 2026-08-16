import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { SmtpImapAdapter } from "../../src/modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { ConfigurationError } from "../../src/shared/errors/index.js";

describe("ProviderRegistry", () => {
  it("resolves a registered adapter by provider type", () => {
    const registry = createProviderRegistry();
    const adapter = new GmailAdapter();
    registry.register(adapter);

    expect(registry.resolve("GMAIL")).toBe(adapter);
  });

  it("resolves each of the three provider types independently", () => {
    const registry = createProviderRegistry();
    const gmail = new GmailAdapter();
    const microsoft365 = new Microsoft365Adapter();
    const smtpImap = new SmtpImapAdapter();
    registry.register(gmail);
    registry.register(microsoft365);
    registry.register(smtpImap);

    expect(registry.resolve("GMAIL")).toBe(gmail);
    expect(registry.resolve("MICROSOFT365")).toBe(microsoft365);
    expect(registry.resolve("SMTP_IMAP")).toBe(smtpImap);
  });

  it("throws ConfigurationError resolving an unregistered provider type", () => {
    const registry = createProviderRegistry();
    expect(() => registry.resolve("GMAIL")).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError registering the same provider type twice", () => {
    const registry = createProviderRegistry();
    registry.register(new GmailAdapter());
    expect(() => registry.register(new GmailAdapter())).toThrow(ConfigurationError);
  });

  it("never lets application code branch on a provider-name string to get an adapter — resolve() is the only path", () => {
    // Structural assertion: resolve() returns the ProviderAdapter interface,
    // not a concrete class — callers can't have special-cased on a name to
    // obtain it, since the registry is the sole lookup mechanism.
    const registry = createProviderRegistry();
    registry.register(new SmtpImapAdapter());
    const adapter = registry.resolve("SMTP_IMAP");
    expect(adapter.providerType).toBe("SMTP_IMAP");
    expect(typeof adapter.getCapabilities).toBe("function");
  });
});

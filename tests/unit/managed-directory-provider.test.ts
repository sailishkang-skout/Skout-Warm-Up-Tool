import { describe, expect, it } from "vitest";
import { createGoogleWorkspaceDirectoryProvider } from "../../src/modules/managed-directory/infrastructure/google-workspace-directory-provider.js";
import { createMicrosoft365DirectoryProvider } from "../../src/modules/managed-directory/infrastructure/microsoft365-directory-provider.js";

describe("managed directory providers", () => {
  it("does not fabricate Google Workspace customers when reseller APIs are unconfigured", async () => {
    const provider = createGoogleWorkspaceDirectoryProvider(false);
    expect(provider.getConfigurationStatus()).toBe("NOT_CONFIGURED");
    const created = await provider.createCustomer({ domain: "acme.com", displayName: "Acme" });
    expect(created.ok).toBe(false);
    expect(created.errorCode).toBe("NOT_CONFIGURED");
  });

  it("does not fabricate Microsoft tenants when CSP APIs are unconfigured", async () => {
    const provider = createMicrosoft365DirectoryProvider(false);
    expect(provider.getConfigurationStatus()).toBe("NOT_CONFIGURED");
    const created = await provider.createMailbox({
      providerCustomerId: "x",
      emailAddress: "user@acme.com",
    });
    expect(created.ok).toBe(false);
    expect(created.errorCode).toBe("NOT_CONFIGURED");
  });
});

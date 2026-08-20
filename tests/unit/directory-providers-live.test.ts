import { describe, expect, it, vi } from "vitest";
import { createGoogleWorkspaceDirectoryProvider } from "../../src/modules/managed-directory/infrastructure/google-workspace-directory-provider.js";
import { createMicrosoft365DirectoryProvider } from "../../src/modules/managed-directory/infrastructure/microsoft365-directory-provider.js";

describe("live directory adapters", () => {
  it("returns Google user ids from Admin SDK responses and does not invent them", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("existing%40acme.com") || href.includes("existing@acme.com")) {
        return new Response(JSON.stringify({ id: "google-user-1", primaryEmail: "existing@acme.com" }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    }) as unknown as typeof fetch;

    const provider = createGoogleWorkspaceDirectoryProvider({
      config: {
        adminEmail: "admin@skout.test",
        serviceAccount: {
          clientEmail: "reseller@skout.test",
          privateKey: "unused",
          tokenUri: "https://oauth2.googleapis.com/token",
        },
      },
      getAccessToken: async () => "token",
      fetchImpl,
    });

    const created = await provider.createMailbox({
      providerCustomerId: "C123",
      emailAddress: "existing@acme.com",
    });
    expect(created.ok).toBe(true);
    expect(created.value?.providerMailboxId).toBe("google-user-1");
  });

  it("returns Microsoft Graph user ids and does not invent them", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("user%40acme.com") || href.includes("user@acme.com")) {
        return new Response(JSON.stringify({ id: "graph-user-1", userPrincipalName: "user@acme.com" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const provider = createMicrosoft365DirectoryProvider({
      config: { tenantId: "t", clientId: "id", clientSecret: "secret" },
      getAccessToken: async () => "token",
      fetchImpl,
    });
    const created = await provider.createMailbox({
      providerCustomerId: "t",
      emailAddress: "user@acme.com",
    });
    expect(created.ok).toBe(true);
    expect(created.value?.providerMailboxId).toBe("graph-user-1");
  });

  it("does not call live APIs from automated tests without an injected token", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createGoogleWorkspaceDirectoryProvider({
      config: {
        adminEmail: "admin@skout.test",
        serviceAccount: { clientEmail: "a@b.c", privateKey: "k", tokenUri: "https://oauth2.googleapis.com/token" },
      },
      fetchImpl,
    });
    const result = await provider.createCustomer({ domain: "acme.com", displayName: "Acme" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("NOT_CONFIGURED");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

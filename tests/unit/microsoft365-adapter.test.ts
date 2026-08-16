import { describe, expect, it, vi } from "vitest";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { ConfigurationError, OAuthError, ProviderError } from "../../src/shared/errors/index.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";

const CONFIG = { clientId: "ms-client-id", clientSecret: "ms-client-secret", redirectUri: "https://app.test/ms-callback" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function credentialWithToken(accessToken: string): ProviderCredential {
  return {
    providerAccountId: asProviderAccountId("22222222-2222-2222-2222-222222222222"),
    kind: "MICROSOFT_OAUTH",
    secretData: { accessToken },
  };
}

describe("Microsoft365Adapter — unconfigured", () => {
  it("reports NOT_CONFIGURED and every oauth.* method throws ConfigurationError", () => {
    const adapter = new Microsoft365Adapter();
    expect(adapter.getConfigurationStatus()).toBe("NOT_CONFIGURED");
    expect(() => adapter.oauth.getAuthorizationUrl({ state: "s", codeChallenge: "c" })).toThrow(ConfigurationError);
    expect(adapter.oauth.exchangeCodeForTokens({ code: "x", codeVerifier: "y" })).rejects.toThrow(ConfigurationError);
    expect(adapter.oauth.refreshAccessToken("refresh")).rejects.toThrow(ConfigurationError);
  });
});

describe("Microsoft365Adapter — configured", () => {
  it("getAuthorizationUrl targets the Microsoft identity platform with PKCE and state", () => {
    const adapter = new Microsoft365Adapter({ config: CONFIG });
    const url = new URL(adapter.oauth.getAuthorizationUrl({ state: "the-state", codeChallenge: "the-challenge" }));

    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain("Mail.Send");
  });

  it("exchangeCodeForTokens returns a token set on success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "Mail.Send" }));
    const adapter = new Microsoft365Adapter({ config: CONFIG, fetchImpl });

    const tokenSet = await adapter.oauth.exchangeCodeForTokens({ code: "auth-code", codeVerifier: "verifier" });
    expect(tokenSet.accessToken).toBe("at-1");
    expect(tokenSet.refreshToken).toBe("rt-1");
  });

  it("exchangeCodeForTokens throws OAuthError without leaking error_description", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant", error_description: "leak-me-not" }, 400));
    const adapter = new Microsoft365Adapter({ config: CONFIG, fetchImpl });

    try {
      await adapter.oauth.exchangeCodeForTokens({ code: "bad", codeVerifier: "v" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthError);
      expect((error as Error).message).not.toContain("leak-me-not");
    }
  });

  it("refreshAccessToken throws a non-retryable ProviderError on invalid_grant, retryable otherwise", async () => {
    const invalidGrantAdapter = new Microsoft365Adapter({
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)),
    });
    await expect(invalidGrantAdapter.oauth.refreshAccessToken("dead")).rejects.toMatchObject({ retryable: false });

    const transientAdapter = new Microsoft365Adapter({
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ error: "server_error" }, 500)),
    });
    await expect(transientAdapter.oauth.refreshAccessToken("token")).rejects.toMatchObject({ retryable: true });
  });

  it("validateConnection maps Graph /me responses to VALID/INVALID_CREDENTIAL/PROVIDER_ERROR", async () => {
    const healthyAdapter = new Microsoft365Adapter({
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ mail: "user@example.com" })),
    });
    expect((await healthyAdapter.validateConnection(credentialWithToken("at"))).status).toBe("VALID");

    const unauthAdapter = new Microsoft365Adapter({
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    });
    expect((await unauthAdapter.validateConnection(credentialWithToken("at"))).status).toBe("INVALID_CREDENTIAL");
  });

  it("getMailboxIdentity falls back to userPrincipalName when mail is absent", async () => {
    const adapter = new Microsoft365Adapter({
      config: CONFIG,
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ userPrincipalName: "upn@example.com", displayName: "UPN User" })),
    });
    const identity = await adapter.getMailboxIdentity(credentialWithToken("at"));
    expect(identity).toEqual({ emailAddress: "upn@example.com", displayName: "UPN User" });
  });

  it("getMailboxIdentity throws ProviderError with no credential", async () => {
    const adapter = new Microsoft365Adapter({ config: CONFIG, fetchImpl: vi.fn() });
    await expect(adapter.getMailboxIdentity(undefined)).rejects.toBeInstanceOf(ProviderError);
  });
});

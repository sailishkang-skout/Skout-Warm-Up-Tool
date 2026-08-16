import { describe, expect, it, vi } from "vitest";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { ConfigurationError, OAuthError, ProviderError } from "../../src/shared/errors/index.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";

const CONFIG = { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "https://app.test/callback" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function credentialWithToken(accessToken: string): ProviderCredential {
  return {
    providerAccountId: asProviderAccountId("11111111-1111-1111-1111-111111111111"),
    kind: "GOOGLE_OAUTH",
    secretData: { accessToken },
  };
}

describe("GmailAdapter — unconfigured", () => {
  it("reports NOT_CONFIGURED and every oauth.* method throws ConfigurationError", () => {
    const adapter = new GmailAdapter();
    expect(adapter.getConfigurationStatus()).toBe("NOT_CONFIGURED");
    expect(() => adapter.oauth.getAuthorizationUrl({ state: "s", codeChallenge: "c" })).toThrow(ConfigurationError);
    expect(adapter.oauth.exchangeCodeForTokens({ code: "x", codeVerifier: "y" })).rejects.toThrow(ConfigurationError);
    expect(adapter.oauth.refreshAccessToken("refresh")).rejects.toThrow(ConfigurationError);
  });
});

describe("GmailAdapter — configured", () => {
  it("reports CONFIGURED", () => {
    const adapter = new GmailAdapter({ config: CONFIG });
    expect(adapter.getConfigurationStatus()).toBe("CONFIGURED");
  });

  it("getAuthorizationUrl includes PKCE, state, and offline/consent params", () => {
    const adapter = new GmailAdapter({ config: CONFIG });
    const url = new URL(adapter.oauth.getAuthorizationUrl({ state: "the-state", codeChallenge: "the-challenge" }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain("gmail.send");
    expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  });

  it("exchangeCodeForTokens returns a token set on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "openid email" }),
    );
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    const tokenSet = await adapter.oauth.exchangeCodeForTokens({ code: "auth-code", codeVerifier: "verifier" });

    expect(tokenSet.accessToken).toBe("at-1");
    expect(tokenSet.refreshToken).toBe("rt-1");
    expect(tokenSet.scope).toBe("openid email");
    expect(tokenSet.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [, requestInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(requestInit.body as string);
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_secret")).toBe(CONFIG.clientSecret);
  });

  it("exchangeCodeForTokens throws OAuthError on a provider error response, never leaking error_description in the message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "invalid_grant", error_description: "sensitive detail" }, 400));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    await expect(adapter.oauth.exchangeCodeForTokens({ code: "bad", codeVerifier: "v" })).rejects.toThrow(OAuthError);
    try {
      await adapter.oauth.exchangeCodeForTokens({ code: "bad", codeVerifier: "v" });
    } catch (error) {
      expect((error as Error).message).not.toContain("sensitive detail");
    }
  });

  it("exchangeCodeForTokens throws a retryable ProviderError on a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    await expect(adapter.oauth.exchangeCodeForTokens({ code: "c", codeVerifier: "v" })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("refreshAccessToken returns a new token set, falling back to the prior refresh token when omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: "at-2", expires_in: 3600, scope: "openid" }));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    const tokenSet = await adapter.oauth.refreshAccessToken("original-refresh-token");
    expect(tokenSet.accessToken).toBe("at-2");
    expect(tokenSet.refreshToken).toBe("original-refresh-token");
  });

  it("refreshAccessToken throws a non-retryable ProviderError on invalid_grant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    await expect(adapter.oauth.refreshAccessToken("dead-token")).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("refreshAccessToken throws a retryable ProviderError on a transient provider error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "server_error" }, 500));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });

    await expect(adapter.oauth.refreshAccessToken("token")).rejects.toMatchObject({ retryable: true });
  });

  it("validateConnection returns NOT_CONFIGURED when no credential is supplied", async () => {
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl: vi.fn() });
    const result = await adapter.validateConnection(undefined);
    expect(result.status).toBe("NOT_CONFIGURED");
  });

  it("validateConnection returns VALID on a 200 from the userinfo endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ email: "user@example.com" }));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });
    const result = await adapter.validateConnection(credentialWithToken("at"));
    expect(result.status).toBe("VALID");
  });

  it("validateConnection returns INVALID_CREDENTIAL on a 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });
    const result = await adapter.validateConnection(credentialWithToken("at"));
    expect(result.status).toBe("INVALID_CREDENTIAL");
  });

  it("validateConnection returns PROVIDER_ERROR on a 500 or a network failure", async () => {
    const adapter500 = new GmailAdapter({ config: CONFIG, fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 500 })) });
    expect((await adapter500.validateConnection(credentialWithToken("at"))).status).toBe("PROVIDER_ERROR");

    const adapterNetworkFail = new GmailAdapter({ config: CONFIG, fetchImpl: vi.fn().mockRejectedValue(new Error("boom")) });
    expect((await adapterNetworkFail.validateConnection(credentialWithToken("at"))).status).toBe("PROVIDER_ERROR");
  });

  it("getMailboxIdentity resolves the email/displayName on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ email: "found@example.com", name: "Found User" }));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });
    const identity = await adapter.getMailboxIdentity(credentialWithToken("at"));
    expect(identity).toEqual({ emailAddress: "found@example.com", displayName: "Found User" });
  });

  it("getMailboxIdentity throws ProviderError when no credential is supplied", async () => {
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl: vi.fn() });
    await expect(adapter.getMailboxIdentity(undefined)).rejects.toBeInstanceOf(ProviderError);
  });

  it("getConnectionHealth maps VALID -> HEALTHY with a latency measurement", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ email: "user@example.com" }));
    const adapter = new GmailAdapter({ config: CONFIG, fetchImpl });
    const health = await adapter.getConnectionHealth(credentialWithToken("at"));
    expect(health.status).toBe("HEALTHY");
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

import { ConfigurationError, OAuthError, ProviderError } from "../../../../shared/errors/index.js";
import type {
  ProviderAdapter,
  ProviderConfigurationStatus,
  ProviderMailboxIdentity,
} from "../../domain/provider-adapter.js";
import type { ProviderCapabilities } from "../../domain/provider-capabilities.js";
import type { ProviderConnectionValidationResult } from "../../domain/provider-connection-validation.js";
import type { ProviderCredential } from "../../domain/provider-credential.js";
import type { ProviderHealthResult } from "../../domain/provider-health.js";
import type { OAuthAuthorizationRequest, OAuthCodeExchangeRequest, OAuthOperations, OAuthTokenSet } from "../../domain/oauth-operations.js";

const PROVIDER_TYPE = "GMAIL" as const;

const CAPABILITIES: ProviderCapabilities = {
  canSend: true,
  canReceive: true,
  supportsThreads: true,
  supportsFolders: false, // Gmail uses labels, not a folder hierarchy
  supportsOAuth: true,
  supportsSmtp: false,
  supportsImap: false,
};

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/**
 * Minimum scopes to (a) resolve the authenticated identity for mismatch
 * checking (`openid`, `email`) and (b) let a mailbox eventually send/receive
 * once warmup exists (`gmail.send`, `gmail.readonly`) — this deployment
 * would otherwise have to send users through OAuth consent a second time
 * later. Deliberately NOT `gmail.modify` or any admin/directory scope:
 * warmup never needs to delete mail or manage the account.
 */
const OAUTH_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface GmailAdapterOptions {
  readonly config?: GoogleOAuthConfig;
  /** Injectable for tests — defaults to the global `fetch`. Never mocked in production. */
  readonly fetchImpl?: typeof fetch;
}

interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GoogleUserinfoResponse {
  readonly email?: string;
  readonly name?: string;
}

function toTokenSet(body: GoogleTokenResponse): OAuthTokenSet {
  if (!body.access_token || !body.expires_in) {
    throw new OAuthError("Google did not return a usable token response");
  }
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
    scope: body.scope ?? OAUTH_SCOPES.join(" "),
  };
}

function accessTokenOf(credential: ProviderCredential | undefined): string | undefined {
  const token = credential?.secretData.accessToken;
  return typeof token === "string" ? token : undefined;
}

/**
 * Real Gmail OAuth 2.0 (authorization code + PKCE) behind the Stage 5
 * adapter contract. Every network call goes through `fetchImpl`, injected
 * so tests exercise this adapter's logic against a mocked provider API
 * without a real Google account or client secret (see Stage 6 spec section
 * 23) — production never supplies `fetchImpl` and gets the real global
 * `fetch`. See ../../README.md for the scope rationale.
 */
export class GmailAdapter implements ProviderAdapter {
  readonly providerType = PROVIDER_TYPE;
  readonly oauth: OAuthOperations;

  private readonly config: GoogleOAuthConfig | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GmailAdapterOptions = {}) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.oauth = {
      getAuthorizationUrl: (request) => this.getAuthorizationUrl(request),
      exchangeCodeForTokens: (request) => this.exchangeCodeForTokens(request),
      refreshAccessToken: (refreshToken) => this.refreshAccessToken(refreshToken),
    };
  }

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  getConfigurationStatus(): ProviderConfigurationStatus {
    return this.config ? "CONFIGURED" : "NOT_CONFIGURED";
  }

  async validateConnection(credential: ProviderCredential | undefined): Promise<ProviderConnectionValidationResult> {
    if (!this.config) {
      return { status: "NOT_CONFIGURED", message: "Google OAuth is not configured for this deployment.", checkedAt: new Date() };
    }
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return { status: "NOT_CONFIGURED", message: "No Google credential is stored for this mailbox.", checkedAt: new Date() };
    }

    try {
      const response = await this.fetchImpl(USERINFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 401 || response.status === 403) {
        return { status: "INVALID_CREDENTIAL", message: "Google rejected the stored credential.", checkedAt: new Date() };
      }
      if (!response.ok) {
        return { status: "PROVIDER_ERROR", message: "Google's identity endpoint returned an unexpected error.", checkedAt: new Date() };
      }
      return { status: "VALID", message: "Google confirmed the credential is valid.", checkedAt: new Date() };
    } catch {
      return { status: "PROVIDER_ERROR", message: "Could not reach Google to validate the credential.", checkedAt: new Date() };
    }
  }

  async getMailboxIdentity(credential: ProviderCredential | undefined): Promise<ProviderMailboxIdentity> {
    if (!this.config) {
      throw new ProviderError(PROVIDER_TYPE, "Gmail OAuth is not configured for this deployment", { retryable: false });
    }
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      throw new ProviderError(PROVIDER_TYPE, "No Google credential is stored for this mailbox", { retryable: false });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Google to resolve mailbox identity", {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ProviderError(PROVIDER_TYPE, "Google rejected the request to resolve mailbox identity", {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as GoogleUserinfoResponse;
    if (!body.email) {
      throw new ProviderError(PROVIDER_TYPE, "Google did not return an email address for this credential", {
        retryable: false,
      });
    }
    return { emailAddress: body.email, ...(body.name ? { displayName: body.name } : {}) };
  }

  async getConnectionHealth(credential: ProviderCredential | undefined): Promise<ProviderHealthResult> {
    if (!this.config) {
      return { status: "UNKNOWN", providerType: PROVIDER_TYPE, checkedAt: new Date(), message: "Gmail OAuth is not configured for this deployment." };
    }
    const startedAt = Date.now();
    const validation = await this.validateConnection(credential);
    const latencyMs = Date.now() - startedAt;

    const statusMap = {
      VALID: "HEALTHY",
      INVALID_CREDENTIAL: "UNAUTHENTICATED",
      PROVIDER_ERROR: "UNAVAILABLE",
      NOT_CONFIGURED: "UNKNOWN",
    } as const;

    return {
      status: statusMap[validation.status],
      providerType: PROVIDER_TYPE,
      checkedAt: validation.checkedAt,
      latencyMs,
      message: validation.message,
    };
  }

  private getAuthorizationUrl(request: OAuthAuthorizationRequest): string {
    if (!this.config) {
      throw new ConfigurationError("Google OAuth is not configured for this deployment");
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: OAUTH_SCOPES.join(" "),
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
      // Required together to reliably receive a refresh_token even for a
      // user re-authorizing a mailbox they've connected before — without
      // `prompt=consent`, Google only issues one on the *first* grant.
      access_type: "offline",
      prompt: "consent",
    });
    return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  private async exchangeCodeForTokens(request: OAuthCodeExchangeRequest): Promise<OAuthTokenSet> {
    if (!this.config) {
      throw new ConfigurationError("Google OAuth is not configured for this deployment");
    }
    const body = new URLSearchParams({
      code: request.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: request.codeVerifier,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Google to exchange the authorization code", {
        retryable: true,
        cause: error,
      });
    }

    const parsed = (await response.json()) as GoogleTokenResponse;
    if (!response.ok || parsed.error) {
      // `error_description` never leaves this process — only in `details`,
      // which the error handler logs but never returns to a client.
      throw new OAuthError("Google rejected the authorization code exchange", {
        details: { reason: parsed.error, description: parsed.error_description },
      });
    }
    return toTokenSet(parsed);
  }

  private async refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet> {
    if (!this.config) {
      throw new ConfigurationError("Google OAuth is not configured for this deployment");
    }
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Google to refresh the access token", {
        retryable: true,
        cause: error,
      });
    }

    const parsed = (await response.json()) as GoogleTokenResponse;
    if (!response.ok || parsed.error) {
      // `invalid_grant` means the refresh token itself was revoked/expired —
      // not retryable, the caller must re-run the full OAuth flow rather
      // than retry. Anything else (e.g. a transient 5xx) is retryable.
      throw new ProviderError(PROVIDER_TYPE, "Google rejected the refresh token request", {
        retryable: parsed.error !== "invalid_grant",
        details: { reason: parsed.error },
      });
    }
    // Google does not always rotate the refresh token on refresh — the
    // caller keeps the previous one when this response omits it.
    return toTokenSet({ ...parsed, refresh_token: parsed.refresh_token ?? refreshToken });
  }
}

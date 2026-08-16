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

const PROVIDER_TYPE = "MICROSOFT365" as const;

const CAPABILITIES: ProviderCapabilities = {
  canSend: true,
  canReceive: true,
  supportsThreads: true,
  supportsFolders: true, // Outlook/Graph has a real folder hierarchy
  supportsOAuth: true,
  supportsSmtp: false,
  supportsImap: false,
};

// "common" accepts both work/school and personal Microsoft accounts —
// the right default for a product that doesn't yet know which tenant type
// a given customer's mailboxes belong to.
const AUTHORIZATION_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";

/**
 * Minimum scopes to (a) resolve the authenticated identity for mismatch
 * checking (`openid`, `email`) and (b) let a mailbox eventually send/receive
 * once warmup exists (`Mail.Send`, `Mail.Read`) — avoiding a second consent
 * round-trip later. `offline_access` is required to receive a refresh
 * token at all under the v2.0 endpoint. Deliberately NOT any
 * `Directory.*`/admin-consent scope: warmup never needs tenant
 * administration.
 */
const OAUTH_SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/Mail.Read",
] as const;

export interface MicrosoftOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface Microsoft365AdapterOptions {
  readonly config?: MicrosoftOAuthConfig;
  /** Injectable for tests — defaults to the global `fetch`. Never mocked in production. */
  readonly fetchImpl?: typeof fetch;
}

interface MicrosoftTokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GraphMeResponse {
  readonly mail?: string;
  readonly userPrincipalName?: string;
  readonly displayName?: string;
}

function toTokenSet(body: MicrosoftTokenResponse): OAuthTokenSet {
  if (!body.access_token || !body.expires_in) {
    throw new OAuthError("Microsoft did not return a usable token response");
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
 * Real Microsoft 365 OAuth 2.0 (authorization code + PKCE) against the
 * Microsoft identity platform (login.microsoftonline.com) and Microsoft
 * Graph, behind the Stage 5 adapter contract. Structured identically to
 * `GmailAdapter` — see that file's doc comment for the `fetchImpl`
 * injection rationale.
 */
export class Microsoft365Adapter implements ProviderAdapter {
  readonly providerType = PROVIDER_TYPE;
  readonly oauth: OAuthOperations;

  private readonly config: MicrosoftOAuthConfig | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Microsoft365AdapterOptions = {}) {
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
      return { status: "NOT_CONFIGURED", message: "Microsoft OAuth is not configured for this deployment.", checkedAt: new Date() };
    }
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return { status: "NOT_CONFIGURED", message: "No Microsoft credential is stored for this mailbox.", checkedAt: new Date() };
    }

    try {
      const response = await this.fetchImpl(GRAPH_ME_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 401 || response.status === 403) {
        return { status: "INVALID_CREDENTIAL", message: "Microsoft rejected the stored credential.", checkedAt: new Date() };
      }
      if (!response.ok) {
        return { status: "PROVIDER_ERROR", message: "Microsoft Graph returned an unexpected error.", checkedAt: new Date() };
      }
      return { status: "VALID", message: "Microsoft confirmed the credential is valid.", checkedAt: new Date() };
    } catch {
      return { status: "PROVIDER_ERROR", message: "Could not reach Microsoft Graph to validate the credential.", checkedAt: new Date() };
    }
  }

  async getMailboxIdentity(credential: ProviderCredential | undefined): Promise<ProviderMailboxIdentity> {
    if (!this.config) {
      throw new ProviderError(PROVIDER_TYPE, "Microsoft OAuth is not configured for this deployment", { retryable: false });
    }
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      throw new ProviderError(PROVIDER_TYPE, "No Microsoft credential is stored for this mailbox", { retryable: false });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(GRAPH_ME_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Microsoft Graph to resolve mailbox identity", {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ProviderError(PROVIDER_TYPE, "Microsoft Graph rejected the request to resolve mailbox identity", {
        retryable: response.status >= 500,
      });
    }

    const body = (await response.json()) as GraphMeResponse;
    const emailAddress = body.mail ?? body.userPrincipalName;
    if (!emailAddress) {
      throw new ProviderError(PROVIDER_TYPE, "Microsoft Graph did not return an email address for this credential", {
        retryable: false,
      });
    }
    return { emailAddress, ...(body.displayName ? { displayName: body.displayName } : {}) };
  }

  async getConnectionHealth(credential: ProviderCredential | undefined): Promise<ProviderHealthResult> {
    if (!this.config) {
      return { status: "UNKNOWN", providerType: PROVIDER_TYPE, checkedAt: new Date(), message: "Microsoft OAuth is not configured for this deployment." };
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
      throw new ConfigurationError("Microsoft OAuth is not configured for this deployment");
    }
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: OAUTH_SCOPES.join(" "),
      state: request.state,
      code_challenge: request.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  }

  private async exchangeCodeForTokens(request: OAuthCodeExchangeRequest): Promise<OAuthTokenSet> {
    if (!this.config) {
      throw new ConfigurationError("Microsoft OAuth is not configured for this deployment");
    }
    const body = new URLSearchParams({
      code: request.code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: request.codeVerifier,
      scope: OAUTH_SCOPES.join(" "),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Microsoft to exchange the authorization code", {
        retryable: true,
        cause: error,
      });
    }

    const parsed = (await response.json()) as MicrosoftTokenResponse;
    if (!response.ok || parsed.error) {
      // `error_description` never leaves this process — only in `details`,
      // which the error handler logs but never returns to a client.
      throw new OAuthError("Microsoft rejected the authorization code exchange", {
        details: { reason: parsed.error, description: parsed.error_description },
      });
    }
    return toTokenSet(parsed);
  }

  private async refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet> {
    if (!this.config) {
      throw new ConfigurationError("Microsoft OAuth is not configured for this deployment");
    }
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      scope: OAUTH_SCOPES.join(" "),
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new ProviderError(PROVIDER_TYPE, "Could not reach Microsoft to refresh the access token", {
        retryable: true,
        cause: error,
      });
    }

    const parsed = (await response.json()) as MicrosoftTokenResponse;
    if (!response.ok || parsed.error) {
      // `invalid_grant` means the refresh token itself was revoked/expired —
      // not retryable, the caller must re-run the full OAuth flow rather
      // than retry. Anything else (e.g. a transient 5xx) is retryable.
      throw new ProviderError(PROVIDER_TYPE, "Microsoft rejected the refresh token request", {
        retryable: parsed.error !== "invalid_grant",
        details: { reason: parsed.error },
      });
    }
    // The v2.0 endpoint always rotates the refresh token — but fall back to
    // the previous one defensively if a response ever omits it.
    return toTokenSet({ ...parsed, refresh_token: parsed.refresh_token ?? refreshToken });
  }
}

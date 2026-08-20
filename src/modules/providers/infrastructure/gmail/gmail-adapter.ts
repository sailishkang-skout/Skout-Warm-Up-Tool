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
import type { ProviderSendOutcome, SendMessageCommand } from "../../domain/send-message.js";

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
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// Bounded so a hung connection can never leave a send attempt open
// indefinitely — Stage 9 spec section 7's "timeout" case is exactly what
// this guards against. Whatever happens after this fires is, by
// definition, something this adapter cannot confirm the outcome of.
const SEND_TIMEOUT_MS = 15_000;

// Stage 12.1 fallback only — production always supplies
// `refreshTimeoutMs` from `config.providers.credentialRefreshTimeoutMs`
// (see build-services.ts), sourced from `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`
// (shared/config/schema.ts). This default only matters for adapters
// constructed without an explicit value (tests, or a future call site that
// doesn't wire config through).
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;

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
  /** Stage 12.1 — bounds `refreshAccessToken`'s network call. Defaults to `DEFAULT_REFRESH_TIMEOUT_MS`; production supplies `config.providers.credentialRefreshTimeoutMs`. */
  readonly refreshTimeoutMs?: number;
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

/** RFC 5322 header values must not contain raw CR/LF — collapses any that somehow arrive to a single space rather than rejecting the send outright. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Gmail's `messages.send` takes a full base64url-encoded RFC 5322 message, not a structured JSON body — this is the smallest valid one for a plain-text, single-recipient warmup message. */
function buildRawMessage(command: SendMessageCommand): string {
  const headers = [
    `From: ${sanitizeHeaderValue(command.from)}`,
    `To: ${sanitizeHeaderValue(command.to)}`,
    `Subject: ${sanitizeHeaderValue(command.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${command.body}`);
}

interface GmailSendResponse {
  readonly id?: string;
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
  private readonly refreshTimeoutMs: number;

  constructor(options: GmailAdapterOptions = {}) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
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

  /**
   * Real Gmail `messages.send`. Never throws for a provider-side outcome —
   * every branch below returns a `ProviderSendOutcome`; only a genuine
   * network/timeout failure (where Gmail's actual receipt of the request
   * cannot be confirmed) resolves to `SEND_UNKNOWN` (Stage 9 spec section
   * 7) rather than being guessed at as a retryable failure. Gmail's API
   * has no client-supplied idempotency token, so this is the most this
   * adapter can honestly know — see docs/ARCHITECTURE.md's idempotency
   * section.
   */
  async sendMessage(credential: ProviderCredential | undefined, command: SendMessageCommand): Promise<ProviderSendOutcome> {
    if (!this.config) {
      return { status: "PERMANENT_FAILURE", retryable: false, safeReason: "Gmail is not configured for this deployment." };
    }
    const accessToken = accessTokenOf(credential);
    if (!accessToken) {
      return { status: "AUTH_FAILED", retryable: false, safeReason: "No Google credential is stored for this mailbox." };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(SEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: buildRawMessage(command) }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch {
      // Deliberately not `error: unknown` details in `safeReason` — a
      // network exception here could equally mean "never left this
      // process" or "Gmail received it and the response was lost." Only
      // an actual HTTP response below counts as a confirmed outcome.
      return {
        status: "SEND_UNKNOWN",
        retryable: false,
        safeReason: "Could not confirm whether Gmail received the send request (network failure or timeout).",
      };
    }

    if (response.status === 401 || response.status === 403) {
      return { status: "AUTH_FAILED", retryable: false, safeReason: "Gmail rejected the stored credential." };
    }
    if (response.status === 429) {
      return { status: "RATE_LIMITED", retryable: true, safeReason: "Gmail rate-limited the send request." };
    }
    if (response.status >= 500) {
      return { status: "TEMPORARY_FAILURE", retryable: true, safeReason: "Gmail returned a server error." };
    }
    if (!response.ok) {
      return { status: "PERMANENT_FAILURE", retryable: false, safeReason: "Gmail rejected the send request as invalid." };
    }

    const body = (await response.json().catch(() => ({}))) as GmailSendResponse;
    return { status: "ACCEPTED", retryable: false, ...(body.id ? { providerMessageId: body.id } : {}) };
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
        // Stage 12.1: bounds this call so a hung token endpoint can never
        // leave a credential refresh open indefinitely — the same
        // reasoning SEND_TIMEOUT_MS already applies to the send call
        // above, on an independent, separately-configured budget (refresh
        // is a much smaller request/response than a send, and — unlike a
        // send — is always safe to simply retry, so it doesn't need
        // SEND_UNKNOWN's "outcome unconfirmable" treatment).
        signal: AbortSignal.timeout(this.refreshTimeoutMs),
      });
    } catch (error) {
      // `AbortSignal.timeout` firing rejects with a `DOMException` named
      // "TimeoutError" (verified: distinct from a plain network failure,
      // e.g. connection refused, which rejects with a different error
      // shape) — classified separately so callers (`resolve-fresh-credential.ts`)
      // can tell "the request never got a chance to complete" apart from
      // other transient failures, even though both are equally retryable
      // today.
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      throw new ProviderError(
        PROVIDER_TYPE,
        isTimeout ? "Timed out waiting for Google to refresh the access token" : "Could not reach Google to refresh the access token",
        { retryable: true, details: { reason: isTimeout ? "timeout" : "network_failure" }, cause: error },
      );
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

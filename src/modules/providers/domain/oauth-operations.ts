/** What a successful token exchange or refresh yields — never persisted as-is; the caller wraps it into a `ProviderCredential` before it reaches a `ProviderCredentialStore`. */
export interface OAuthTokenSet {
  readonly accessToken: string;
  /** Absent when the provider didn't issue one on this call (e.g. a refresh that doesn't rotate it) — the caller keeps the previously stored refresh token in that case. */
  readonly refreshToken?: string;
  readonly expiresAt: Date;
  readonly scope: string;
}

export interface OAuthAuthorizationRequest {
  readonly state: string;
  /** PKCE S256 code challenge — base64url(sha256(codeVerifier)). */
  readonly codeChallenge: string;
}

export interface OAuthCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
}

/**
 * OAuth-specific operations a `ProviderAdapter` may optionally support (see
 * `ProviderAdapter.oauth`) — never added to the base `ProviderAdapter`
 * contract itself, since SMTP/IMAP has no OAuth flow to implement. This is
 * the same reasoning Stage 5 already applied to `sendMessage`/
 * `receiveMessages`: don't force a provider to implement functionality it
 * cannot support (see src/modules/providers/README.md).
 */
export interface OAuthOperations {
  /** Builds the provider's authorization URL. Pure/synchronous — no network call, no side effect. */
  getAuthorizationUrl(request: OAuthAuthorizationRequest): string;
  exchangeCodeForTokens(request: OAuthCodeExchangeRequest): Promise<OAuthTokenSet>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokenSet>;
}

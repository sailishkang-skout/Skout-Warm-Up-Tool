# Providers

**Responsibility**: the `ProviderAdapter` contract (`domain/provider-adapter.ts`)
and its concrete implementations (`infrastructure/gmail`, `infrastructure/microsoft365`,
`infrastructure/smtp-imap`). Provider-specific behavior — auth flow, rate limits,
capability differences — lives entirely inside the relevant adapter and is never
duplicated into business-logic modules. Also owns the `ProviderAccount`
aggregate (the connection/configuration relationship between a mailbox and its
provider — never credentials) and the `ProviderCredentialStore` boundary
(where credentials actually live is opaque to every other module).

**Boundary**:
- `mailbox` (and later `warmup`/`conversations`) depend only on `ProviderAdapter`
  exported from `domain/`, never on a specific adapter class. Selecting the
  right adapter for a mailbox goes through `ProviderRegistry.resolve()`
  (`application/provider-registry.ts`) — never a switch statement scattered
  across callers.
- Every adapter distinguishes *supports* (`getCapabilities()` — static, per
  provider type) from *currently configured* (`getConfigurationStatus()` — per
  deployment) from *currently working for this mailbox* (`validateConnection()`
  result — per credential). Warmup logic must branch on capabilities
  (`provider.capabilities.canSend`), never on `provider === "GMAIL"`.
- Each adapter subfolder documents the external configuration (OAuth client
  credentials, SMTP/IMAP host settings, etc.) it requires. None of that
  configuration is faked or stubbed into "success" when absent — Gmail/
  Microsoft 365 fail closed to `NOT_CONFIGURED`/`ConfigurationError` when
  their OAuth client id/secret/redirect URI aren't set (see
  `src/shared/config/schema.ts`); `SmtpImapAdapter` is still a Stage 5
  skeleton (`smtp-imap/`'s own doc comment) since Stage 6 deliberately
  scoped real SMTP/IMAP onboarding out (see the root README's Stage 6
  section).
- An adapter's OAuth-specific operations (`getAuthorizationUrl`,
  `exchangeCodeForTokens`, `refreshAccessToken`) live on the optional
  `ProviderAdapter.oauth` field, not the base contract — `SmtpImapAdapter`
  leaves it `undefined` rather than being forced to implement something it
  has no OAuth flow for. `sendMessage` (`domain/send-message.ts`) followed
  the identical pattern in Stage 9: optional on `ProviderAdapter`, real on
  `GmailAdapter`/`Microsoft365Adapter`, left `undefined` on
  `SmtpImapAdapter` (no safe implementation exists yet — never faked).
  `receiveMessages` remains excluded entirely; no caller needs it yet.
- `sendMessage` never throws for a provider-side outcome — every branch
  (accepted, auth failure, rate limited, transient/permanent rejection, or
  `SEND_UNKNOWN` when the provider's actual receipt can't be confirmed due
  to a network/timeout failure) returns a normal `ProviderSendOutcome`.
  Callers (`warmup/infrastructure/adapter-warmup-send-provider.ts`)
  translate this into their own domain vocabulary — this module's outcome
  type is deliberately not shared with `warmup`'s, keeping the dependency
  direction one-way (`warmup → providers`, never the reverse).
- Credentials never appear on `ProviderAccount`, in `RequestContext`, in an API
  response, or in a log line — only `ProviderCredentialStore.getCredential()`
  ever returns one, and only a `ProviderAdapter` method ever receives one.
  `infrastructure/postgres-provider-credential-store.ts` is the production
  implementation: every credential is AES-256-GCM encrypted before it
  reaches Postgres (`migrations/007_create_provider_credentials.sql`), never
  deleted on revoke (only marked `REVOKED`), and read-time expiry-checked.
  `infrastructure/in-memory-provider-credential-store.ts` is now a fast test
  double only, kept for unit tests that don't need real Postgres — it still
  refuses to construct when `isProduction` is true as a second line of
  defense, but the composition root never uses it.
- `application/resolve-fresh-credential.ts` is the single token-refresh
  implementation — refreshes an access token within `REFRESH_BUFFER_MS` of
  expiry via `adapter.oauth.refreshAccessToken`, persists the result, and
  revokes (never silently retries) a credential whose refresh token itself
  turns out to be dead. Originally private to `mailbox/application/mailbox-service.ts`
  (Stage 6); extracted in Stage 9 so `warmup`'s real send path reuses the
  exact same logic rather than a second implementation.

**Provider type naming**: `GMAIL`/`MICROSOFT365`/`SMTP_IMAP` (not the Stage 5
spec's suggested `GOOGLE`/`MICROSOFT_365`) — kept from Stage 3 since renaming
would mean an unjustified schema-breaking migration for the same provider
families. `provider_credentials.credential_type` uses its own, more granular
vocabulary (`GOOGLE_OAUTH`/`MICROSOFT_OAUTH`/`SMTP`/`IMAP`) since one mailbox
provider can have more than one credential shape.

**Target stage**: Stage 3 (`ProviderAccount` persistence foundation), Stage 5
(adapter contract, capability model, registry, credential-store boundary,
skeleton adapters), Stage 6 (real Gmail/Microsoft 365 OAuth, encrypted
credential storage — see `src/modules/oauth/README.md` for the flow
orchestration that drives these adapters), Stage 9 (real `sendMessage` on
Gmail/Microsoft 365, used by `warmup`'s execution worker). Real SMTP/IMAP
sending is still a later stage.

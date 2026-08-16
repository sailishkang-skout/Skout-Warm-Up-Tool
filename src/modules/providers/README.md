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
  credentials, SMTP/IMAP host settings, etc.) it will require once real
  auth is implemented — none of that configuration is faked or stubbed into
  "success" when absent; every Stage 5 adapter fails closed
  (`NOT_CONFIGURED`/`ProviderError`) rather than fabricating connectivity.
- Credentials never appear on `ProviderAccount`, in `RequestContext`, in an API
  response, or in a log line — only `ProviderCredentialStore.getCredential()`
  ever returns one, and only a `ProviderAdapter` method ever receives one.
  `infrastructure/in-memory-provider-credential-store.ts` is the Stage 5
  implementation and is explicitly, structurally non-production (refuses to
  construct when `isProduction` is true).

**Provider type naming**: `GMAIL`/`MICROSOFT365`/`SMTP_IMAP` (not the Stage 5
spec's suggested `GOOGLE`/`MICROSOFT_365`) — kept from Stage 3 since renaming
would mean an unjustified schema-breaking migration for the same provider
families.

**Target stage**: Stage 3 (`ProviderAccount` persistence foundation), Stage 5
(adapter contract, capability model, registry, credential-store boundary,
skeleton adapters). Real OAuth/SMTP/IMAP implementations are later stages.

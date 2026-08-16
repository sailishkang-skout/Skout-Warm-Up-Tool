# OAuth

**Responsibility**: orchestrates the Gmail/Microsoft 365 OAuth 2.0
authorization-code + PKCE flow end to end — `OAuthConnectionService.initiate`
(generates PKCE + state, records a `connection_attempts` row, returns the
provider's authorization URL) and `.handleCallback` (validates state,
exchanges the code, verifies the authenticated identity matches the mailbox,
persists the credential, and drives the mailbox to `CONNECTED` via
`MailboxService.connectMailbox`). See `application/oauth-connection-service.ts`
for the full step-by-step and the security invariant each step enforces.

**Boundary**:
- Depends on `providers` for `ProviderAdapter.oauth` (token exchange/refresh/
  authorization URL) and `ProviderCredentialStore` (encrypted persistence) —
  never constructs a credential's wire format itself beyond assembling what
  `ProviderCredentialStore.saveCredential` expects.
- Depends on `mailbox` for `MailboxRepository` (tenant-scoped lookups) and
  `MailboxService.connectMailbox` (the actual CONNECTING → CONNECTED
  transition and provider-account outcome recording) — this module never
  mutates `Mailbox.status` directly.
- `OAuthStateStore` and `OAuthConnectionLock` are Redis-backed
  (`infrastructure/redis-*.ts`) — always, in every environment, since
  `REDIS_URL` is unconditionally required (`src/shared/config/schema.ts`).
  The in-memory implementations exist only as fast unit-test doubles.
- `application/oauth-connection-service.ts` never depends on `ioredis`
  directly — only on the narrow `OAuthStateStore`/`OAuthConnectionLock`
  interfaces (see `src/shared/redis/redis-client.ts` for why).

**Security invariants** (see the Stage 6 spec sections referenced inline in
`oauth-connection-service.ts`):
- OAuth state is cryptographically random, single-use (atomic
  get-and-delete), short-lived (10 minutes), and the *only* source of truth
  for which tenant/mailbox/provider a callback belongs to — nothing in the
  callback's own query string is trusted for that.
- The authenticated provider identity is compared against the mailbox being
  connected before any credential is persisted; a mismatch
  (`ProviderIdentityMismatchError`) discards the freshly obtained tokens
  without ever calling `ProviderCredentialStore.saveCredential`.
- Every failure path returns the same generic message to the caller
  ("Invalid or expired connection request" / "Authorization was denied or
  could not be completed") — the real reason lives only in the audit trail
  (`MAILBOX_CONNECTION_FAILED`/`OAUTH_STATE_REPLAY_DETECTED`, both tenant- and
  reason-tagged) and structured logs.
- A per-mailbox `OAuthConnectionLock` (Redis `SET NX EX`) blocks a second
  concurrent OAuth attempt for the same mailbox — the abuse-protection
  primitive Stage 6 asks for short of full API rate limiting (see spec
  section 19). Full per-tenant/per-IP rate limiting is a documented future
  boundary, not this module's job.

**Target stage**: Stage 6 (Google/Microsoft 365 OAuth connection flow).

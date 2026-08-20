# Mailbox

**Responsibility**: owns the `Mailbox` aggregate and its connection lifecycle
state machine (`PENDING → CONNECTING → CONNECTED → DISCONNECTED`, with `ERROR`
reachable from `CONNECTING`/`CONNECTED` and able to retry back to
`CONNECTING`). `enabled` is a separate boolean, not a lifecycle state — a
mailbox can be enabled but `DISCONNECTED`, or disabled but still `CONNECTED`;
see `domain/mailbox-lifecycle.ts` for the full transition graph and
`domain/mailbox.ts` for why warmup-progress/risk states (WARMING, HEALTHY,
AT_RISK, ...) were deliberately dropped from this enum — they belong to a
future warmup_profile, not to whether the mailbox is connected.

Never touches plaintext credentials directly — `MailboxService` only ever
receives an opaque `ProviderCredential` from the `providers` module's
`ProviderCredentialStore` boundary, and only to hand it to a
`ProviderAdapter` method.

**Boundary**:
- All lifecycle transitions go through `mailbox-lifecycle.ts`'s
  `assertValidMailboxTransition` — `MailboxService` requests a transition, it
  never assigns `status` directly, and no other module mutates it at all.
- Depends on `providers` for the `ProviderAdapter`/`ProviderRegistry`/
  `ProviderCredentialStore` interfaces, never on a specific adapter
  implementation directly.
- Depends on `tenancy` for tenant scoping only.
- `MailboxService.createMailbox` creates the mailbox and its `ProviderAccount`
  atomically (one DB transaction) — every mailbox has exactly one provider
  account by construction, never as an eventually-consistent afterthought.
- `connectMailbox`/`getConnectionHealth`/`getBaseline` all route through
  `resolveFreshCredential` before touching the adapter — a near-expired
  OAuth access token is refreshed (via `adapter.oauth.refreshAccessToken`)
  and re-persisted first; a refresh token that's no longer valid gets
  revoked rather than retried forever (Stage 6 spec section 10).
- The actual OAuth authorization-code/callback flow (state, PKCE, identity
  validation, credential persistence) is orchestrated by the `oauth` module,
  not here — see `src/modules/oauth/README.md`. This module only exposes
  the connection-lifecycle primitives (`connectMailbox`, capabilities,
  health/connection/baseline snapshots) that flow depends on.
- `timezone` (Stage 12) — an IANA identifier (e.g. `"America/New_York"`),
  never a raw UTC offset; validated via `shared/time`'s `Intl`-backed
  `isValidIanaTimezone` in `createMailbox`, defaults to `"UTC"` when
  omitted so every pre-Stage-12 mailbox keeps behaving exactly as before.
  Set only at creation (`POST /mailboxes`) — there is no field-level update
  endpoint for any mailbox field yet (`provider`/`emailAddress` are
  likewise immutable after creation; only the action-style mutators
  `connect`/`disconnect`/`enable`/`disable` exist). Consumed by
  `warmup/domain/send-window.ts` to evaluate a mailbox's configured send
  window in its own local time — see `warmup/README.md`'s "Scheduling
  (Stage 12)" section.

**Target stage**: Stage 3 (persistence foundation), Stage 5 (lifecycle,
provider abstraction, `MailboxService`, `/api/v1/mailboxes`), Stage 6
(audit events on create/disconnect, credential refresh, connection
health/snapshot/baseline endpoints), Stage 12 (`timezone`).

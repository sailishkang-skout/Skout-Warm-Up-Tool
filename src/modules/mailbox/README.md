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

Also owns encrypted credential *references* for connected mailboxes (never
plaintext credentials — see the `providers` module's `ProviderCredentialStore`
boundary, consumed here via `MailboxService`).

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

**Target stage**: Stage 3 (persistence foundation), Stage 5 (lifecycle,
provider abstraction, `MailboxService`, `/api/v1/mailboxes`).

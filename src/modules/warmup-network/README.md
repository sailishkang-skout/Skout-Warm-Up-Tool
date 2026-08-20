# Warmup network

**Stage 20 schema + Stage 21 productionization — Skout-managed warmup
network (opt-in recipient routing).**

This module stores **infrastructure** for a global, Skout-owned pool of
warmup mailboxes and selects a recipient for a customer warmup send. It
does **not** decide whether a send should happen, how many sends a
customer may make, or how ramp/safety/reputation should change. Those
remain in `warmup` (frozen Stages 12–19).

Default: **off**. Existing warmup still **self-sends**.

```
Customer mailbox (already safety-gated)
  → AdapterWarmupSendProvider
  → WarmupNetworkRouter.selectWarmupMailbox (only if prefer|require)
  → generateWarmupMessage({ fromAddress, toAddress })
  → ProviderAdapter.sendMessage
```

Operators onboard real mailboxes with the existing mailbox/OAuth flow,
then `INSERT` network rows. There is no customer mutation API and no fake
provider accounts.

See `docs/WARMUP_NETWORK.md`.

Tenant **sending-identity** pools (which of the tenant’s own mailboxes
sends next) live in `src/modules/warmup-pool/` and
`docs/WARMUP_POOL_ROTATION.md`. Do not conflate the two.

# Warmup identity pool

**Tenant-owned sending-identity pools** — which of a tenant’s **own**
mailboxes should receive the next warmup allocation.

This is **not** the Skout-managed partner **warmup-network**
(`src/modules/warmup-network/`, `docs/WARMUP_NETWORK.md`). That layer
picks a **recipient**. This module picks a **sender**. Default: pools are
optional; mailboxes without a pool keep the existing per-mailbox APIs.

See `docs/WARMUP_POOL_ROTATION.md`.

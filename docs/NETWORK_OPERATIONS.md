# Network operations

Internal fleet: `warmup_networks.kind = INTERNAL` (default). Not tenant-owned.

Partner fleet: `kind = PARTNER` plus `membership_status` and optional
`owner_tenant_id` / consent timestamps. A mailbox is never a recipient just
because it exists.

Membership lifecycle: INVITED → PENDING_APPROVAL → ACTIVE → PAUSED /
QUARANTINED / SUSPENDED / REMOVED.

Owned partner member APIs (tenant must match `owner_tenant_id`):

- `POST /api/v1/warmup-network/mailboxes/:id/pause`
- `POST /api/v1/warmup-network/mailboxes/:id/resume`
- `POST /api/v1/warmup-network/mailboxes/:id/quarantine`
- `POST /api/v1/warmup-network/mailboxes/:id/consent`
- `POST /api/v1/warmup-network/mailboxes/:id/leave`

Skout-internal members (null owner) cannot be mutated by customer API keys.

`GET /api/v1/warmup-network/health` is aggregate counts, not a risk decision.

Network policy (ALLOW/DEFER/REDUCE/block) may shrink routing. It does not
set mailbox risk to LOW.

Kill switch: `POST /api/v1/operations/kill-switches` (operator for
GLOBAL/PROVIDER/NETWORK) and `WARMUP_KILL_SWITCH_GLOBAL`.

Keep `WARMUP_NETWORK_ROUTING_MODE=off` until a real eligible fleet exists.

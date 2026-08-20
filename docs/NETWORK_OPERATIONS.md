# Network operations

Internal fleet: `warmup_networks.kind = INTERNAL` (default). Not tenant-owned.

Partner fleet: `kind = PARTNER` plus `membership_status` and optional
`owner_tenant_id` / consent timestamps. A mailbox is never a recipient just
because it exists.

Pause/quarantine of **owned** partner members:

`POST /api/v1/warmup-network/mailboxes/:id/pause`
`POST /api/v1/warmup-network/mailboxes/:id/quarantine`

These succeed only when `owner_tenant_id` matches the authenticated tenant.
Skout-internal members (null owner) cannot be mutated by customer API keys.

Kill switch: `POST /api/v1/operations/kill-switches` and
`WARMUP_KILL_SWITCH_GLOBAL`.

# Warmup identity pool / rotation

Tenant-owned **sending-identity** pools: which of a tenant’s **own**
mailboxes should be used for the next warmup allocation. Domain rotation
means picking another eligible **mailbox** whose email is on another
domain. **Mailbox is the source of truth.** Domain is derived from the
mailbox email address. This service never pairs mailbox A with domain B.

## Two different Stage 20 layers

| Layer | Module | What it selects | Default |
|---|---|---|---|
| Skout-managed **partner warmup-network** | `src/modules/warmup-network/`, `migrations/029_create_warmup_network.sql` | **Recipient** (a Skout mailbox) for a customer send | `WARMUP_NETWORK_ROUTING_MODE=off` |
| Tenant **identity pool** (this doc) | `src/modules/warmup-pool/`, `migrations/030_create_warmup_pools.sql` | **Sender** (the tenant’s own mailbox) for the next allocation | Pools optional; per-mailbox APIs unchanged |

Do not duplicate 029 tables. Do not redesign the partner network.

## Main platform vs this service

**This service:** eligibility, identity pools, deterministic rotation,
binding a new execution intent to an existing per-mailbox session.

**Main platform (out of scope):** UI, billing, CRM, campaigns, contacts,
sequences, suppression, LinkedIn, outreach, webhooks, outbound publishers,
AI agents.

## Architecture

```
Optional tenant pool
  → selector (WHO)
  → mailbox's existing warmup session
  → safety gate / ramp / volume (HOW MUCH) — unchanged
  → execution intent (mailbox_id = session.mailbox_id)
  → worker claims intent — never rotates
```

Sessions remain permanently keyed to one `mailbox_id`. Rotation never
rebinds `warmup_sessions.mailbox_id` and never mutates PENDING / CLAIMED /
EXECUTING / SENT intents.

If a mailbox is **not** in any ACTIVE pool, `/api/v1/mailboxes/:id/warmup`
behavior is unchanged (regression). Pools do not become mandatory.

The daily **scheduler is frozen** and still advances each due session
independently. Automatic production-wide rotation of every customer is
**not** implied by shipping this module. Operators (or a future, explicit
scheduler change) call `POST /api/v1/warmup/pools/:poolId/select` or
`/allocate` when they want pool-based WHO selection.

## Models

`warmup_pools`: tenant-scoped, `ACTIVE | PAUSED | DRAINING`, strategy,
`max_consecutive_same_domain`, `max_domain_share_percent`.

`warmup_pool_memberships`: references existing `mailboxes`. Unique
`(pool_id, mailbox_id)`. Tenant isolation: membership `tenant_id` must
match both pool and mailbox (`CHECK` via trigger + queries always filter
`tenant_id`). Membership `max_daily_warmup_volume` is an extra
**selection** ceiling, not a second volume engine.

## Domain rotation

Never invent a sending domain separate from the mailbox. Diversity uses
`MAX_CONSECUTIVE_SAME_DOMAIN` and `MAX_DOMAIN_SHARE_PERCENT`. If only one
domain is eligible, keep using it.

## Selection algorithm

Deterministic. No AI. No `Math.random`.

Strategies: `ROUND_ROBIN`, `LEAST_USED`, `WEIGHTED`, `HEALTH_FIRST`,
default compose `HEALTH_FIRST_LEAST_USED`.

Gate order: tenant → pool ACTIVE → connected → credential → provider
health → mailbox health → reputation → risk → daily membership capacity →
cooldown → domain concentration → strategy rank.

Score inputs: derived domain health, reputation, risk, daily utilization,
cooldown, `lastSelectedAt`, priority, weight, domain diversity.

Selected mailbox must still pass the **existing** safety gate when
`WarmupService` creates an intent. This module does not copy gate logic.

## Safety

`evaluateSafetyGate` / ramp / execution policy are unchanged. After a
worker **claims** an intent, mailbox identity does not switch. Existing
retry / `SEND_UNKNOWN` behavior stays.

## Concurrency

Postgres `withTransaction` + `FOR UPDATE` on the pool row and membership
rows **in id order**. Atomic select + `last_selected_at` + usage
increment. No Redis locks. No BullMQ.

## Capacity

Membership daily cap = eligibility only. Session
`current_daily_target` / `committed_volume_today` remain HOW MUCH.

## Failure

- Before intent commit: re-select another eligible mailbox (`/allocate`).
- After claim: do not switch mailbox.
- None eligible: `NO_ELIGIBLE_WARMUP_MAILBOX` — do not send, do not pick
  unhealthy.

## Domain health

Tiny derived status `HEALTHY | DEGRADED | BLOCKED | UNKNOWN` from
existing assessments. UNKNOWN is conservative. No second reputation system.

## Examples

1. Tenant has `a@one.test` and `b@two.test` in an ACTIVE pool. Select
   prefers the healthier, least-used mailbox; consecutive same-domain
   limit rotates to the other domain when both remain eligible.
2. Only `one.test` remains eligible → keep selecting it.
3. Mailbox disconnected / no credential / HIGH risk → skipped.
4. Existing `warmup_execution_intents.mailbox_id` is never rewritten.

## Config

| Name | Default |
|---|---|
| `WARMUP_POOL_SELECTION_STRATEGY` | `health_first_least_used` |
| `WARMUP_MAX_DOMAIN_SHARE_PERCENT` | `70` |
| `WARMUP_MAX_CONSECUTIVE_SAME_DOMAIN` | `2` |
| `WARMUP_POOL_SELECTION_COOLDOWN_MS` | `0` |

## APIs

Authenticated, tenant-isolated, no credentials:

`GET/POST /api/v1/warmup/pools`, `GET/PATCH /api/v1/warmup/pools/:poolId`,
`GET/POST /api/v1/warmup/pools/:poolId/mailboxes`,
`GET /api/v1/warmup/pools/:poolId/health`,
`POST .../select`, `POST .../allocate`.

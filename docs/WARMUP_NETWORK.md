# Warmup network (Stage 21 productionization)

Isolated **Skout-managed partner recipients**. This module answers: which
eligible Skout partner mailbox should **receive** this customer warmup
message?

It is **not** a second warmup engine. Volume, ramp, safety-gate, risk,
reputation, scheduling, execution intents, and `SEND_UNKNOWN` stay in
`warmup` / the execution worker.

Tenant **sending-identity** pools (`src/modules/warmup-pool/`, migration
030, `docs/WARMUP_POOL_ROTATION.md`) are a separate layer (who **sends**).
Do not merge the two.

**Tables + router + opt-in send hook ≠ a live fleet.** Empty
`warmup_network_*` tables mean there is no production partner network,
even if the code is deployed.

## Architecture

```
DOMAIN → MAILBOX → ROUTE
```

A network mailbox belongs to exactly one domain. Routing never pairs
domain A with a mailbox of domain B. Domain “rotation” is a **consequence
of mailbox selection**, not an independent domain pick.

The router does **not** call `safety-gate`, `ramp-policy`, or change
`warmup_sessions` volume. Hook is only in
`adapter-warmup-send-provider.ts`.

Pipeline (unchanged except optional recipient):

`MAILBOX → WARMUP → OPTIONAL WARMUP NETWORK → PROVIDER SEND → INBOUND → CONVERSATIONS → CLASSIFICATION → POLICY → INTEGRATION EVENTS`

### Routing modes

| Mode | Behavior |
|---|---|
| `off` (default) | Self-send. **Does not query** network tables. Instant disable. |
| `prefer` | Any eligible member; otherwise self-send. |
| `require` | Any eligible member; else fail closed. |
| `internal` | `kind=INTERNAL` only; fail closed. |
| `partner` | `kind=PARTNER` only; fail closed. |
| `hybrid` | INTERNAL + PARTNER; fail closed. |

A routing infrastructure exception (DB) maps to `TEMPORARY_FAILURE` so the
existing worker retries. Routing failure **must not** mark an intent SENT.
`SEND_UNKNOWN` stays with the existing send/worker path.

## Models

Global (no `tenant_id` on network/pool/domain/mailbox rows):

- `warmup_networks` — ACTIVE/DISABLED, `kind` INTERNAL\|PARTNER (031)
- `warmup_network_pools` — default pool is enough
- `warmup_network_domains` — unique domain, GMAIL|MICROSOFT365, health, auth, capacity
- `warmup_network_mailboxes` — `mailbox_id` FK to existing `mailboxes` (credential reuse). **No tokens.**
- `warmup_network_routing_decisions` — unique `routing_request_key` (warmup intent idempotency key)

Entity states: `ACTIVE`, `DEGRADED`, `COOLDOWN`, `QUARANTINED`, `DISABLED`.
`DEGRADED` is **ineligible**.

Migration **029** is the schema. Do not edit 001–029 in place. Tenant pools
are **030**.

## Eligibility

Pure functions: `isWarmupDomainEligible`, `isWarmupMailboxEligible`.

Domain must be ACTIVE (not DEGRADED/COOLDOWN/QUARANTINED/DISABLED),
supported provider, configurable SPF/DKIM/DMARC `PASS`, health ≥
threshold, remaining daily capacity, reputation not POOR/CRITICAL,
`cooldown_until` not in the future.

Mailbox must be ACTIVE, parent domain eligible, credential_available,
linked `mailboxes` row CONNECTED+enabled, remaining capacity, health ≥
threshold.

Capacity and cooldown (including parent-domain capacity/cooldown) classify
as **TEMPORARY**. Quarantine, disabled network, missing credentials, and
health/auth failures classify as **PERMANENT**.

This is **infrastructure** eligibility, not the warmup safety gate.

## Routing

Deterministic. No `Math.random`.

1. Customer mailbox missing/disconnected/disabled → `CUSTOMER_MAILBOX_DISCONNECTED`
2. `pg_advisory_xact_lock` on `routing_request_key`, then reuse an existing decision
3. Lock candidate mailbox/domain rows `FOR UPDATE` in **id order**
4. Filter eligible
5. Prefer mailboxes not in this customer's recent `SELECTED` decisions
   inside `WARMUP_NETWORK_RECENT_INTERACTION_WINDOW_MS`. If that set is
   empty, fall back to all eligible
6. Sort: same provider as customer, health DESC, remaining capacity DESC, id ASC
7. Reserve mailbox+domain usage with a capacity `WHERE` guard; persist decision
8. Empty/unhealthy pool → `NO_ELIGIBLE_WARMUP_MAILBOX`

Customer mailbox load happens **outside** the routing transaction so the
API pool is not nested-locked.

## Rotation

Recent-interaction avoidance is per **customer mailbox**, not global.
Tenant A’s partners are not treated as recent for tenant B.

Domain spread happens only because different eligible mailboxes live on
different domains.

## Capacity

`daily_capacity` / `usage_count` / `usage_date` on domain and mailbox.
UTC date. Reset when `usage_date` is not today. Independent of
`warmup_sessions.current_daily_target` / `committed_volume_today`.

Concurrent **different** keys competing for the last slot: one `SELECTED`,
one `CAPACITY_EXHAUSTED` (temporary). Concurrent **same** key: one
decision, usage incremented once.

## Health, quarantine

`health_score` 0–100. Quarantine is a reversible SQL status update (ops).
One send failure does not destroy a domain.

Customer-send `AUTH_FAILED` increments `warmup_network.route.auth_failed`
and **does not** set partner `credential_available=false` (send uses
**customer** credentials). Ops may still call `recordAuthFailed` when a
partner mailbox’s own credentials are known bad.

## Providers

GMAIL and MICROSOFT365 only. No SMTP/IMAP receiving. Send still uses
existing `ProviderAdapter.sendMessage` unchanged.

## Concurrency

Advisory lock on the request key plus `FOR UPDATE` in stable id order.
Two concurrent selects cannot both consume the last unit of capacity, and
duplicate keys cannot double-increment usage.

## Security / ownership

GLOBAL Skout-owned network. Customers **cannot mutate** it. There are **no
tenant write APIs** (no POST/PATCH/DELETE). That is intentional, not a
missing CRUD product.

Authenticated tenants may **read** pool metadata (ids, domain, status,
health, mailbox address, `credentialAvailable` boolean). No OAuth tokens
in these tables or JSON. Audit `WARMUP_NETWORK_ROUTED` is ids/outcome only.

Seed via existing mailbox OAuth (`/api/v1/mailboxes`) then operator SQL
`INSERT` into `warmup_network_*`.

## APIs (read-only)

- `GET /api/v1/warmup-network/domains`
- `GET /api/v1/warmup-network/domains/:id`
- `GET /api/v1/warmup-network/mailboxes`
- `GET /api/v1/warmup-network/mailboxes/:id`
- `GET /api/v1/warmup-network/health`

These are **not** `GET /api/v1/integration-events` and are not the
main-platform pull contract.

## Observability

Process counters in `src/shared/observability/metrics.ts` (no new OTEL
exporter). Names only; no tokens, bodies, or PII:

`warmup_network.route.attempt|success|no_eligible|failure|auth_failed|capacity_exhausted|quarantined|provider_mismatch`,
`warmup_network.capacity.remaining`, `warmup_network.mailbox.selected`,
`warmup_network.domain.selected`.

Tenant pool metrics `warmup.pool.*` remain.

## Onboarding (honest)

1. **Infrastructure model** — these tables (Stage 20 schema + Stage 21 hardening)
2. **Real mailbox onboarding** — existing `/api/v1/mailboxes` + OAuth
3. **Real provider connection** — CONNECTED mailbox with stored credentials
4. **SQL membership** — operators `INSERT` `warmup_network_*` rows
5. **Production warmup network** — live Skout-owned mailboxes, DNS, monitoring, on-call — **not implied by deploying this code**

Do not create fake provider accounts.

Leave `WARMUP_NETWORK_ROUTING_MODE=off` until a real eligible fleet exists.

### Before `prefer`

Live partner mailboxes CONNECTED, DNS/auth PASS, capacity > 0, health
above threshold, SQL rows present, metrics dashboards, rollback = set
mode `off`.

### Before `require`

Proven `prefer` in production, enough capacity for peak warmup volume,
on-call for empty-pool/permanent failures, understanding that require
**stops sending** when the pool is empty (it does not self-send).

## Config

See `docs/ENVIRONMENT_REFERENCE.md`. Default routing mode is `off`.

## Compliance boundary

This network exists so customer warmup can interact with Skout-operated
mailboxes in an explainable way. It must not be used to evade provider
abuse systems or to inflate reputation with fabricated engagement.

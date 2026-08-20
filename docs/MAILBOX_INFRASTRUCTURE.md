# Mailbox infrastructure control plane

This service is **one** warmup engine plus **multiple** provider adapters and
**multiple** safe recipient networks.

```
ONE MAILBOX CONTROL PLANE
+ ONE WARMUP CONTROL PLANE
+ ONE EXECUTION CONTROL PLANE
+ Google / Microsoft adapters
+ Internal / Partner recipient sources
```

Sender identity and recipient identity are never the same object. The
network only proposes a recipient. The existing safety gate still decides
whether the **sender** may execute.

## Honesty labels

| Layer | Status in this repository |
|---|---|
| Schema + APIs (domains, provider accounts, roles, network, kill switches, quarantine, operational mailbox states) | **IMPLEMENTED** |
| User OAuth send/inbound (Gmail/Graph) when `GOOGLE_*` / `MICROSOFT_*` triplets are set | **CONFIGURED** only after those env vars exist |
| Google Workspace Reseller / Admin SDK directory | **IMPLEMENTED** in code; **NOT_CONFIGURED** until `GOOGLE_WORKSPACE_*` is set and Google confirms resources |
| Microsoft Graph directory (users) | **IMPLEMENTED** in code; **NOT_CONFIGURED** until `MICROSOFT_CSP_*` is set. Customer-tenant creation via Partner Center remains **NOT_CONFIGURED** |
| Internal/partner fleet | **IMPLEMENTED** schema; **not PRODUCTION ACTIVE** until mailboxes are provisioned, healthy, and routing is deliberately enabled |
| `WARMUP_NETWORK_ROUTING_MODE` | Default **`off`**. Do not enable until the activation sequence in this doc is complete |

## Modes

| Mode | Meaning |
|---|---|
| A | Skout manages customer domain + mailbox lifecycle (directory APIs). Unconfigured deployments return `NOT_CONFIGURED` rather than inventing Google/Microsoft customers. Local mailbox rows are created only after the provider returns a real id. |
| B | Customer already owns the mailbox; Skout connects OAuth (existing path). |
| C | Skout-internal recipient fleet (`warmup_networks.kind = INTERNAL`). |
| D | Partner/customer opt-in recipients (`kind = PARTNER`, explicit membership). |

## Routing (`WARMUP_NETWORK_ROUTING_MODE`)

Default remains **`off`** (self-send, no network lookup).

| Value | Behavior |
|---|---|
| `off` | Self-send |
| `prefer` | Any eligible network member, else self-send |
| `require` | Any eligible member, else fail closed |
| `internal` | INTERNAL members only, fail closed |
| `partner` | PARTNER members only, fail closed |
| `hybrid` | INTERNAL + PARTNER, fail closed |

Routing failure never becomes a successful send. Network policy may
ALLOW/DEFER/REDUCE/TEMPORARY_BLOCK/PERMANENT_BLOCK; it cannot override
risk, eligibility, capacity, or the safety gate.

Tenant GET `/api/v1/warmup-network/mailboxes` returns **opaque ids**, not
partner email addresses.

## Kill switch and quarantine

`WARMUP_KILL_SWITCH_GLOBAL=true` or an `operational_kill_switches` row pauses
**new provider sends** (`TEMPORARY_FAILURE`, retryable). Scopes: GLOBAL,
PROVIDER, NETWORK, TENANT, DOMAIN, MAILBOX. Fleet scopes require operator
keys. `operational_quarantines` blocks MAILBOX/DOMAIN/PROVIDER_ACCOUNT/NETWORK
the same way. Existing claimed intents are not deleted.

## Activation sequence (not done by code alone)

1. Provider agreement and credentials.
2. Domain verification with DNS evidence.
3. Mailbox provisioning confirmed by Google/Microsoft.
4. Health + send/receive verification (manual / certify CLI; not CI).
5. Network membership and health.
6. Controlled routing test.
7. Only then consider changing `WARMUP_NETWORK_ROUTING_MODE`.

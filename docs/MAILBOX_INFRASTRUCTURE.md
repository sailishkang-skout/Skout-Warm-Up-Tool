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

## Modes

| Mode | Meaning |
|---|---|
| A | Skout manages customer domain + mailbox lifecycle (directory APIs). Unconfigured deployments return `NOT_CONFIGURED` rather than inventing Google/Microsoft customers. |
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

Routing failure never becomes a successful send.

Tenant GET `/api/v1/warmup-network/mailboxes` returns **opaque ids**, not
partner email addresses.

## Kill switch

`WARMUP_KILL_SWITCH_GLOBAL=true` or an `operational_kill_switches` GLOBAL
ACTIVE row pauses **new provider sends** (`TEMPORARY_FAILURE`, retryable).
Existing claimed intents still follow the frozen worker; the send boundary
refuses to call Gmail/Graph while paused.

## Honest limitation

Google Workspace Reseller and Microsoft CSP provisioning are **interfaces
plus NOT_CONFIGURED adapters** until reseller/CSP credentials exist. Do not
treat table rows as a live managed Workspace/M365 fleet.

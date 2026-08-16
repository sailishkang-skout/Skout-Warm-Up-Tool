# Domain Intelligence

**Responsibility**: DNS-derived authentication posture for a sending
domain — MX, SPF, DKIM (best-effort, common-selector), and DMARC. Owns
nothing about any specific mailbox or provider; a domain's DNS reality is
the same fact regardless of which tenant or mailbox is asking (see
`health/README.md` for how mailbox-level intelligence consumes this
module's output — `health`'s signal collector and orchestrator are this
module's only consumers).

**Boundary**:
- No dependency on `mailbox`, `providers`, or any Gmail/Microsoft-specific
  logic — this module only knows about domain names and DNS records (Stage
  7 spec section 6: "should not depend on Gmail/Microsoft logic").
- `domain/domain-authentication.ts` defines five-state results
  (`PASS`/`FAIL`/`MISSING`/`UNKNOWN`/`ERROR`) for each check, never a single
  collapsed boolean — a record that doesn't exist, a record that's
  malformed, and a DNS query that itself failed are three different facts
  callers need to tell apart.
- `DomainIntelligenceService` is the only entry point; it never touches
  `ioredis` or `node:dns` directly — those live behind `DomainCache` and
  `DnsResolver`, both narrow interfaces with test doubles usable with no
  real network or Redis (see `application/`).
- Read path: `DomainCache` (Redis, fast) → `domain_intelligence` table
  (Postgres, durable) → real DNS (`infrastructure/node-dns-resolver.ts`),
  falling through only as far as each layer's data is missing or older than
  `DOMAIN_REFRESH_INTERVAL_MS` (24h) — DNS is a stable-ish resource, and
  this service must never become a source of DNS load proportional to
  mailbox-request volume (Stage 7 spec section 16).
- DKIM checks a small, fixed list of selectors real providers actually use
  (`google`, `selector1`, `selector2`, `default`, `k1`, `dkim`) — bounded,
  not a scan. A `MISSING` DKIM result means "none of these known selectors
  resolve," not "DKIM is definitely not configured."

**Target stage**: Stage 7 (mailbox intelligence & warmup baseline).

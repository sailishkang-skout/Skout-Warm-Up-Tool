# Reputation Intelligence

**Scope note (Stage 10, updated Stage 11)**: this module originally planned
a strictly provider/domain-wide, read-only scope for a later stage. Stage 10
deliberately widened it early: mailbox-level, delivery-evidence-derived
reputation *assessment* — with its own status, factors, trends, and
confidence — because it is the same kind of fact (reputation intelligence
about a mailbox's sending) and Stage 10's spec was explicit and detailed
about building it under this name (API at `/reputation`, audit events named
`REPUTATION_*`). Stage 11 then completed the originally-planned scope on
schedule: provider-level and domain-level reputation, below. Both scopes now
live in one module, sharing one evaluation function
(`application/reputation-policy.ts#evaluateReputation`) and one persisted,
append-only assessment row per mailbox.

**Responsibility (Stage 10 — mailbox-level)**: aggregates a *single
mailbox's own* delivery-event history (`delivery-events` module) into
rolling-window evidence (last 24h / last 7d / lifetime), applies
deterministic trend detection and status derivation, and persists an
append-only `ReputationAssessment` history. Feeds `risk` as an additional,
optional input — **it never decides risk or warmup volume itself**; `risk`
remains the sole authority for the overall risk level, and the existing
warmup decision engine remains the sole authority for volume (Stage 10
spec section 9/16).

**Boundary**:
- `domain/reputation-assessment.ts` — `ReputationStatus`
  (`EXCELLENT`/`HEALTHY`/`DEGRADED`/`POOR`/`CRITICAL`/`UNKNOWN`),
  `TrendDirection` (`IMPROVING`/`STABLE`/`DEGRADING`/`UNKNOWN`), and
  `ReputationWindowEvidence` (`deliveryRate`/`bounceRate`/`hardBounceRate`/
  `softBounceRate`/`throttleRate`/`rejectionRate`/`failureRate`/
  `complaintRate`/`unknownRate`, each `number | "UNKNOWN"`). A fresh,
  local `ReputationFactorSeverity` type rather than importing `risk`'s
  `RiskLevel` — the dependency direction is `reputation → risk`, never the
  reverse (same reasoning `warmup`'s `ProviderSendResult` deliberately
  duplicates `providers`' outcome vocabulary instead of importing it
  backward).
- **`UNKNOWN` is never a fabricated zero** (Stage 10 spec section 6/23):
  every rate requires at least `MIN_SAMPLE_SIZE_FOR_RATE` (5) events in its
  window, or it is `"UNKNOWN"`. `hardBounceRate` is **always** `"UNKNOWN"`
  in this implementation — the normalized `DeliveryEventType` taxonomy has
  one combined `BOUNCED` type, not a hard/soft split; this codebase never
  fabricates a distinction the evidence doesn't carry. `softBounceRate`
  uses `DEFERRED` as its proxy ("temporarily undeliverable, try again" is
  exactly what a soft bounce means).
- A genuinely triggered factor (e.g. a real complaint, gated by absolute
  count rather than rate) always takes priority over the "not enough
  evidence" gate, however small the sample — real evidence is never
  suppressed by `UNKNOWN`, and `UNKNOWN` is reserved for "nothing
  concerning triggered, and there also isn't yet enough history to call
  this healthy."
- `application/reputation-policy.ts` (`evaluateReputation`) — pure,
  deterministic, no I/O. Factors are derived from the **last-24h** window
  only (not lifetime totals, which could mask a very recent problem behind
  a long healthy history — Stage 10 spec section 7: "the 24-hour window is
  important for immediate warmup safety"). Trend detection requires both
  the recent and prior 24h windows to individually clear
  `MIN_SAMPLE_SIZE_FOR_TREND`, never derived from one isolated event.
  Complaints are gated by absolute count, not rate — this system's warmup
  volumes are tiny (a profile can start at ~5/day), where industry-standard
  bulk-sender percentages would make a single event look catastrophic; a
  single complaint is still meaningful (flagged at `MEDIUM`), but a
  `CRITICAL` complaint signal requires several. Every threshold constant
  is named and documented in that file, never buried inline.
- `application/reputation-service.ts` — `assessReputation` always computes
  fresh and persists a new row; it is the **write path**, called only by
  `health`'s `MailboxAssessmentService.performRefresh` (which already owns
  the staleness/rate-limit decision of *when* to recompute — this service
  does not re-implement that). `getLatest`/`getHistory` are read-only and
  never trigger a computation, so the `GET /:id/reputation` API can never
  race a background recompute against itself.
- `infrastructure/postgres-reputation-repository.ts` — append-only
  (`migrations/019_create_reputation_assessments.sql`); no update/delete
  method exists on the port at all. "What did Skout believe about this
  mailbox's reputation yesterday" is always answerable.
- `api/reputation-routes.ts` — `GET /:id/reputation`,
  `GET /:id/reputation/history`. Read-only, authenticated like every other
  route; never exposes the internal threshold constants
  `reputation-policy.ts` uses, only their derived output.

## Provider- and domain-level reputation (Stage 11)

Extends the same module and the exact same evaluation function
(`application/reputation-policy.ts#evaluateReputation`) rather than building
a second engine — the only thing that differs between mailbox-, provider-,
and domain-scoped reputation is which `DeliveryEventCounts` are fed in
(`evaluateReputation(counts, { codePrefix })`). No `ProviderRiskEngine`,
`DomainRiskEngine`, or second capacity algorithm was created (Stage 11 spec:
"do not create another intelligence/warmup module").

- **`ProviderReputationSnapshot`** (`domain/reputation-assessment.ts`) —
  aggregates delivery-event evidence across *every mailbox this tenant
  sends through a given provider* (never across tenants — enforced at the
  query level, see `delivery-events/infrastructure/postgres-delivery-event-repository.ts`'s
  `countByEventTypeForProvider`). Factor codes are prefixed `PROVIDER_`
  (e.g. `PROVIDER_HIGH_BOUNCE_RATE`) so they can never collide with the
  mailbox-scoped codes once both flow into `risk`.
- **`DomainReputationSnapshot`** — the same, aggregated across every mailbox
  sharing a sending domain (`countByEventTypeForDomain`, joined against
  `mailboxes.email_address_canonical` — no new column on `delivery_events`
  was needed). Also carries `authentication` (MX/SPF/DKIM/DMARC status
  only), reused directly from `domain-intelligence` rather than re-checked
  (Stage 11 spec: "do not duplicate DNS checks"). Those auth facts already
  flow into `risk` independently via `health.domain` — `authentication`
  here is for visibility only and is never itself re-fed into a risk
  factor, which would double-count the same evidence; only the
  delivery-event-driven `factors` (genuinely new evidence) are.
- **Persistence**: both snapshots are computed in the same assessment cycle
  as the mailbox-level view and embedded in the *same*
  `reputation_assessments` row (`migrations/020_add_provider_domain_reputation.sql`,
  additive — 001-019 untouched) rather than two new tables. From a
  consumer's perspective they're the same fact ("reputation evidence
  available when this mailbox was assessed"), and embedding them gives them
  the same append-only history, tenant isolation, and `GET /:id/reputation`
  API surface for free — no new tables, no new endpoints.
- **`application/reputation-service.ts`** — `assessReputation` now also
  depends on `mailboxService` (to resolve the mailbox's `provider` and
  sending domain) and `domainIntelligenceService` (reused, cached DNS
  facts). Fetches all three scopes' rolling windows in one `Promise.all`.
- **Audit**: `PROVIDER_REPUTATION_DEGRADED`/`_RECOVERED` and
  `DOMAIN_REPUTATION_DEGRADED`/`_RECOVERED`, mirroring the mailbox-level
  `REPUTATION_DEGRADED`/`_RECOVERED` pattern exactly — fired only on a
  status-tier transition, detected against *this mailbox's own previous
  assessment's* embedded provider/domain snapshot (there is no separate
  per-provider/per-domain "last known status" store). **Known, deliberate
  limitation**: if several mailboxes share a provider/domain, each may
  independently detect and audit the same underlying transition around the
  same time — some redundancy, but each event remains a true, safe
  statement, and a dedicated cross-mailbox transition store would be new
  persistence this stage's evidence doesn't yet justify.
- **Invalidation**: unchanged — a new delivery event still only marks *its
  own mailbox* stale (`assessment-invalidation-store.ts`). A delivery event
  affecting mailbox A does **not** invalidate mailbox B's cached assessment
  even if B shares A's provider/domain; B picks up the fresher provider/
  domain evidence on its own next natural refresh. This is deliberate
  restraint (Stage 11 spec section 8: "do not invalidate unrelated
  mailboxes unnecessarily... avoid excessive recalculation"), not a gap —
  no queue or fan-out mechanism was introduced.
- **Risk integration** — see `risk/README.md`.

**Target stage**: Stage 10 (mailbox-level reputation), Stage 11
(provider-level and domain-level reputation).

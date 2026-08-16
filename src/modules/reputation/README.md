# Reputation Intelligence

**Scope note (Stage 10)**: this module's originally-planned scope (below,
under "Future: provider/domain-level signals") targeted Stage 11 and was
strictly provider/domain-wide, read-only, producing no scores or decisions
of its own. Stage 10 deliberately widens that scope now: mailbox-level,
delivery-evidence-derived reputation *assessment* — with its own status,
factors, trends, and confidence — lives here too, because it is the same
kind of fact (reputation intelligence about a mailbox's sending) and Stage
10's spec is explicit and detailed about building it under this name (API
at `/reputation`, audit events named `REPUTATION_*`). This is a deliberate,
documented widening, not a silent redesign — the original provider/domain
scope below is unaffected and remains real future work; it becomes a
second signal source feeding the same module, not a replacement.

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

## Future: provider/domain-level signals (originally Stage 11)

Aggregates provider-level and domain-level reputation signals
(`provider_signals` — not yet built) that aren't specific to a single
mailbox's own send/receive history — e.g. provider-observed throttling
classes, sender reputation indicators available from a given
provider/IP/domain combination. Would feed `health`/`risk` as an
*additional* signal source, read-only, producing no scores or decisions of
its own — unaffected by Stage 10's addition above, and still real future
work.

**Target stage**: Stage 10 (mailbox-level reputation), later stage
(provider/domain-level signals, originally planned as Stage 11).

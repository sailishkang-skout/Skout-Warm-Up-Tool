# Health

**Responsibility**: the mailbox health engine, plus the orchestrator that
ties health together with `risk`, `policy`, and `domain-intelligence` into
one persisted assessment. Maintains six independent, explainable
dimensions (`connection`, `authentication`, `sending`, `receiving`,
`domain`, `configuration`) — never one collapsed score. `UNKNOWN` is
distinct from `UNHEALTHY`: it means "not yet measured," never a guess.

**Boundary**:
- `domain/signal.ts` defines the full signal taxonomy this layer is
  designed to reason about; `application/signal-collector.ts` only ever
  emits the subset actually measurable today (see that file's own doc
  comment for exactly which, and why the rest aren't emitted yet — no
  signal here is ever fabricated).
- `domain/freshness.ts` is the single central policy for how long a signal
  stays trustworthy — every place that needs a TTL reads from
  `SIGNAL_FRESHNESS_WINDOWS`, never a hardcoded number at the call site.
- `application/mailbox-health-evaluator.ts` is a pure function — no I/O, no
  database, no network — that turns collected signals into a
  `MailboxHealthAssessment`.
- `application/mailbox-assessment-service.ts` (`MailboxAssessmentService`)
  is the orchestrator: the only place that actually calls
  `MailboxService`/`DomainIntelligenceService`, feeds their output through
  `signal-collector` → `mailbox-health-evaluator`, then (Stage 10) calls
  `reputation`'s `assessReputation` and threads its output into `risk`
  (`evaluateRisk`) alongside `policy` (`evaluateEligibility`,
  `recommendCapacity`) to assemble one `AssessmentSnapshot`. It lives here
  — not as a separate "mailbox-intelligence" module — because health is
  the pipeline's entry point; `risk`, `policy`, and `reputation` remain
  independently testable pure/narrow functions that never call back into
  this module.
- `application/assessment-invalidation-store.ts` (Stage 10, port only —
  `infrastructure/redis-assessment-invalidation-store.ts` is the real
  implementation) — the "reassessment-needed marker" (Stage 10 spec
  section 17): a mailbox marked stale here is recomputed the next time
  anything calls `getAssessment`, not synchronously when the marker is
  set. `getAssessment` checks it alongside the existing time-based
  freshness window (`freshness.ts`) — either one being expired/stale
  triggers a recompute. Deliberately a narrow, dependency-free port (not
  the full `MailboxAssessmentService`) so `delivery-events` can depend on
  it directly without creating a module dependency cycle
  (`health → reputation → delivery-events → health`).
- `AssessmentSnapshot` (domain/assessment-snapshot.ts) is append-only —
  `mailbox_assessments` never overwrites a row — so
  `domain/assessment-change.ts`'s `detectChanges` can compare any two
  points in a mailbox's history. Detection only; no notification exists
  yet.
- `api/mailbox-assessment-routes.ts` exposes `/:id/intelligence`,
  `/:id/risk`, `/:id/eligibility`, `/:id/capacity`,
  `/:id/intelligence/history`, and `/:id/intelligence/refresh` (rate-limited
  to once per minute per mailbox) under `/api/v1/mailboxes`. Kept as one
  facade rather than split per-module routers so the API contract doesn't
  change based on which module owns which internal computation.
- Depends on `mailbox` (`MailboxService.getConnectionHealth`, tenant-scoped
  mailbox lookup) and `domain-intelligence` (`DomainIntelligenceService`)
  for raw inputs, and on `risk`/`policy` for the rest of the pipeline —
  never on a specific provider adapter or DNS library directly, and never
  branches on `provider === "GMAIL"` anywhere in a policy.

**Target stage**: Stage 7 (mailbox intelligence & warmup baseline), Stage
10 (reputation wiring, staleness invalidation).

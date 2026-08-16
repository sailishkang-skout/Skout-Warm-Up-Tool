# Policy

**Responsibility**: the decision boundary. Consumes `health` and `risk`
output and produces the two authoritative, explainable decisions a future
warmup engine consumes without re-deriving them itself:

- `WarmupEligibilityAssessment` (`application/warmup-eligibility-policy.ts`)
  — `ELIGIBLE` / `CONDITIONALLY_ELIGIBLE` / `NOT_ELIGIBLE` /
  `REQUIRES_REVIEW`, always with `reasons`.
- `CapacityRecommendation` (`application/capacity-policy.ts`) — a
  minimum/recommended/maximum daily-volume band plus confidence, derived
  from the eligibility decision alone.

**Boundary**:
- Both policies are pure, deterministic functions — no I/O, no database,
  no clock reads beyond the caller-supplied `assessedAt`.
- `warmup-eligibility-policy.ts` reads `MailboxHealthAssessment` (`health`)
  and `RiskAssessment` (`risk`) as its only inputs; `capacity-policy.ts`
  reads only this module's own `EligibilityDecision` — it does not read
  `health`/`risk` directly, so a future engine can trust
  `CapacityRecommendation` without re-checking eligibility itself.
- `CapacityRecommendation` numbers are deliberately conservative, fixed
  starter-ramp constants today — no warmup engine has ever sent from any
  mailbox yet, so there is no real historical behavior to base a
  recommendation on. **Still true after Stage 10**: real delivery-event
  history now exists and does adapt warmup behavior, but that adaptation
  runs through `risk`/`warmup/application/ramp-policy.ts` instead (see
  `reputation/README.md`) — deliberately not by giving this function
  access to per-mailbox history, since `capacity` deliberately stays a
  pure function of eligibility alone and `ramp-policy.ts` is the one place
  Stage 8 already built for day-to-day adaptive volume. A later stage
  could still replace these constants with a richer model if a real
  product need for that emerges.
- Neither policy schedules or executes anything — `warmup` and
  `scheduling` are the modules responsible for consuming these decisions
  and eventually acting on them.

**Target stage**: Stage 7 (mailbox intelligence & warmup baseline).

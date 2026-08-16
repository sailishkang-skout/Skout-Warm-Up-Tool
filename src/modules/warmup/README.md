# Warmup

**Responsibility**: `WarmupProfile` — configuration and intelligence inputs
for a future warmup engine (starting/target/maximum daily volume, ramp
strategy, risk tolerance, pause conditions). Deliberately not scheduling
state: there is no send history, no cadence engine, no job queue here.
`active` defaults to `false` at creation so a profile existing is never
itself what starts sending.

**Boundary**:
- `domain/warmup-profile.ts` defines the model; `application/`,
  `infrastructure/` hold its repository port and Postgres implementation
  (`warmup_profiles`, one row per mailbox).
- Consumes decisions from `policy` (`WarmupEligibilityAssessment`,
  `CapacityRecommendation`) once an actual engine exists to read them — it
  does not itself decide eligibility or capacity, and does not re-derive
  either from `health`/`risk` directly.
- `pauseConditions` holds stable, machine-readable codes (e.g.
  `"RISK_CRITICAL"`, `"PROVIDER_DISCONNECTED"`) a future engine would check
  before sending — not implemented here, just the declared configuration
  surface for it.
- No sending, scheduling, worker, or conversation logic lives here yet —
  that is future work for this module plus `scheduling`.

**Target stage**: Stage 7 (profile foundation). Worker engine and actual
sending are later stages.

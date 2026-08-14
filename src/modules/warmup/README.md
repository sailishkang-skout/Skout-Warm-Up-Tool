# Warmup

**Responsibility**: the adaptive warmup engine — `WarmupProfile` (starting/
target/maximum volume, ramp policy, safety limits, active days, risk tolerance),
the current recommended-volume calculation, and the schedule generation that
`scheduling` turns into jobs. Consumes signals from `health`, `risk`, and
`domain-intelligence`, and consumes decisions from `policy` — it does not itself
decide INCREASE/MAINTAIN/REDUCE/PAUSE (that is `policy`'s job); it executes what
policy decides.

**Boundary**:
- No single hard-coded global volume curve. Ramp behavior is expressed as a
  provider-aware, tenant-configurable policy object, not a fixed table.
- Depends on `mailbox` (for lifecycle state), `providers` (for provider-specific
  limits/capabilities), `policy` (for the increase/maintain/reduce/pause
  decision), and `conversations` (to execute warmup sends) — but does not reach
  into any of their internals.

**Target stage**: Stage 7 (profile + scheduling foundation), Stage 8 (worker
engine).

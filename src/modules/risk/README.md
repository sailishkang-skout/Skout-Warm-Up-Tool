# Risk

**Responsibility**: the risk engine. Consumes a `MailboxHealthAssessment`
(from `health`) and produces a `RiskAssessment` — a `riskLevel`
(`UNKNOWN`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`), an integer `riskScore`
(0-100), and the list of `riskFactors` that produced it.

**Boundary**:
- `application/risk-policy.ts`'s `evaluateRisk` is pure and deterministic —
  no I/O, no clock reads beyond the caller-supplied `assessedAt`. Each
  triggered risk factor contributes a documented, configurable weight
  (`RISK_FACTOR_WEIGHTS`) toward `riskScore`, capped at 100 — the score is
  a *representation* of the factors, never computed independently of them
  or with false precision (an integer, not "72.3819").
- Reads `MailboxHealthAssessment` (a `health` domain type) as its only
  required input; never reads a database, Redis, or any infrastructure
  directly, and never calls back into `health` or `policy`.
- `policy` reads this module's output (alongside `health`'s) to decide
  eligibility — this module has no knowledge of eligibility, capacity, or
  warmup at all.
- `RiskPolicyInput.reputation` (Stage 10, optional) — when present,
  `evaluateRisk` re-weights `reputation`'s own already-gated `factors`
  (`HIGH_BOUNCE_RATE`/`HIGH_HARD_BOUNCE_RATE`/`HIGH_THROTTLE_RATE`/
  `HIGH_PROVIDER_REJECTION_RATE`/`HIGH_FAILURE_RATE`/`COMPLAINT_SIGNAL`/
  `DEGRADING_DELIVERY_TREND`/`DEGRADING_BOUNCE_TREND`/
  `DEGRADING_PROVIDER_TREND`) into `RISK_FACTOR_WEIGHTS`. This module
  never re-derives a rate or a trend from raw delivery events itself — it
  only reads `reputation`'s already-computed conclusions, and only the
  factor codes it explicitly recognizes (an unrecognized code is silently
  ignored, never a crash). Every one of these weights is calibrated so no
  single reputation factor alone reaches the `CRITICAL` threshold (70) —
  "CRITICAL should require strong evidence" (Stage 10 spec section 10):
  reaching `CRITICAL` from reputation alone requires multiple
  corroborating factors, never one noisy signal. Omitting `reputation`
  entirely behaves exactly as before Stage 10 — every pre-existing caller
  and test keeps working unchanged.

**Target stage**: Stage 7 (mailbox intelligence & warmup baseline), Stage
10 (reputation-derived risk factors).

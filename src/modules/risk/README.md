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
  input; never reads a database, Redis, or any infrastructure directly, and
  never calls back into `health` or `policy`.
- `policy` reads this module's output (alongside `health`'s) to decide
  eligibility — this module has no knowledge of eligibility, capacity, or
  warmup at all.

**Target stage**: Stage 7 (mailbox intelligence & warmup baseline).

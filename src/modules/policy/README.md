# Policy

**Responsibility**: the central decision engine. Consumes `health`, `risk`,
`domain-intelligence`/`reputation` signals and warmup state, and produces
explicit, versioned decisions — `INCREASE | MAINTAIN | REDUCE | PAUSE |
RECOVERY | READY | NOT_READY` — each with a reason, the supporting signals, a
policy version, and a timestamp, persisted to `policy_decisions`.

**Boundary**:
- This is the *only* place business-critical warmup/readiness decisions are
  made. `warmup` workers and API handlers call into this module and execute its
  decision; they do not re-derive or override it inline.
- Outbound readiness is dynamic: this module is re-evaluated continuously, not
  only at the end of a warmup ramp — a `READY` mailbox can become `AT_RISK` on a
  later evaluation.

**Target stage**: Stage 12.

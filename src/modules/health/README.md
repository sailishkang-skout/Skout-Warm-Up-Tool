# Health

**Responsibility**: the mailbox health engine. Maintains multiple explainable
dimensions (authentication health, delivery health, bounce risk, provider
stability, volume safety, mailbox stability, warmup progress, risk trend) and
produces a health score + confidence + recommendation, with the evidence/signals
used stored alongside the result (`mailbox_health_snapshots`) — never a single
opaque number.

**Boundary**:
- Reads from `delivery-events`, `domain-intelligence`, and `providers`
  signals; does not itself decide warmup volume or readiness — `policy` consumes
  health output as an input to its decisions.

**Target stage**: Stage 11.

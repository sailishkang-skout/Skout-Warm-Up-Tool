# Risk

**Responsibility**: the risk engine. Detects deteriorating conditions
(increased failures, bounce increases, throttling, auth problems, abnormal
sending behavior) and produces both a current risk value and a trend/velocity
(e.g. `risk = 32, risk_velocity = +9/day`) — velocity is tracked as a first-class
signal, not derived ad hoc by callers. Records `mailbox_risk_events`.

**Boundary**:
- Reads the same evidence streams as `health` but is a distinct scoring
  dimension (deterioration-focused vs. overall-standing-focused); `policy` reads
  both, they do not read each other.

**Target stage**: Stage 11.

# Audit

**Responsibility**: append-only record of security-relevant and business-critical
events — lifecycle transitions, policy decisions, API key issuance/revocation,
credential access — in `audit_events`. Cross-cutting: other modules emit audit
entries through this module's application-layer interface rather than writing to
the table directly.

**Boundary**:
- Write-mostly, append-only; no module reads audit data to make a decision
  (decisions belong to `policy`) — audit is for accountability/forensics, not
  runtime branching.

**Target stage**: introduced in Stage 4 (authentication needed a real audit
trail — API key issuance/rotation/revocation, authentication success/failure
— sooner than the original "Stage 6 onward" estimate), hardened further in
Stage 14. Recording is currently fail-open: a failure to persist an audit row
logs an error but never blocks the request it describes — durability
guarantees are part of that later hardening, not this foundation.

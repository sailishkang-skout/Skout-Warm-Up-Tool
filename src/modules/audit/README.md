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

**Target stage**: introduced as a shared capability from Stage 6 onward
(wherever the first state transition needs to be recorded), hardened in
Stage 14.

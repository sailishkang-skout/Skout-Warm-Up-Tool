# Domain Intelligence

**Responsibility**: evaluates authentication and domain-level signals for a
mailbox's sending domain — SPF, DKIM, DMARC alignment, MX/DNS sanity, domain age
where available. Produces the signal set consumed at mailbox assessment time and
continuously by the health/risk engines.

**Boundary**:
- Produces `provider_signals`-shaped evidence; does not itself decide health,
  risk, or warmup behavior — those decisions belong to `health`, `risk`, and
  `policy` respectively, which consume this module's output as one input among
  several.
- Has no dependency on `warmup` or `conversations`.

**Target stage**: signal collection lands in Stage 5–6 (mailbox
assessment); ongoing consumption by Stage 11 (health/risk engines).

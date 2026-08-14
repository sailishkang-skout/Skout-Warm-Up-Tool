# Conversations

**Responsibility**: controlled mailbox-to-mailbox interactions used to execute
warmup activity — `Conversation → message → reply → optional continuation →
completion`. Enforces idempotency (idempotency keys on every send), and guards
against duplicate sends, infinite reply loops, accidental self-mailing,
uncontrolled volume, and repeated identical content patterns.

**Boundary**:
- This module never fabricates engagement or attempts to manipulate a provider's
  spam/reputation signals — all activity here is real, legitimate mailbox
  interaction bounded by the volume `warmup`/`policy` authorize.
- Depends on `providers` to actually send/receive; depends on `warmup` for
  authorized volume, not the reverse.

**Target stage**: Stage 9.

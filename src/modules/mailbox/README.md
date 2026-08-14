# Mailbox

**Responsibility**: owns the `Mailbox` aggregate and its onboarding lifecycle
state machine (`NEW → CONNECTING → CONNECTED → VALIDATING → ASSESSED →
WARMUP_INITIALIZED → WARMING → HEALTHY → OUTBOUND_READY → MONITORING`, plus the
risk states `AT_RISK`, `RECOVERY`, `PAUSED`, `FAILED`, `DISCONNECTED`). Also owns
encrypted credential *references* for connected mailboxes (never plaintext
credentials — see `shared/` encryption abstraction, consumed here).

**Boundary**:
- All lifecycle transitions go through one centralized state-transition function
  in this module's `domain/` layer. No other module — warmup, scheduling,
  workers — mutates mailbox status directly; they request a transition and this
  module validates/applies it.
- Depends on `providers` for the adapter interface (connect/validate) but never
  on a specific provider implementation directly.
- Depends on `tenancy` for tenant scoping only.

**Target stage**: Stage 5 (domain + provider abstraction), Stage 6 (state machine).

# Reputation Intelligence

**Responsibility**: aggregates provider-level and domain-level reputation
signals (`provider_signals`) that aren't specific to a single mailbox's own
send/receive history — e.g. provider-observed throttling classes, sender
reputation indicators available from a given provider/IP/domain combination.
Feeds `health` and `risk` as an additional signal source.

**Boundary**:
- Read-only signal source for `health`/`risk`/`policy`; does not itself produce
  scores or decisions.

**Target stage**: Stage 11.

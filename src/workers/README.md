# Workers

Standalone worker process entrypoints — separate from the API process
(`src/server.ts`), independently restartable/scalable, same bootstrap
pattern (config → logger → database/redis connectivity check → build
services → run). Not BullMQ queue consumers (see `modules/scheduling/README.md`'s
Stage 12 correction).

- `execution-worker-process.ts` (Stage 12) — ticks `WarmupScheduler.runTick`
  on `WARMUP_WORKER_POLL_INTERVAL_MS` (default 30s). Contains no domain logic of its own. **Frozen** with
  Stage 12/12.1.
- `inbound-poller-process.ts` (Stage 13A) — ticks conversation inbound sync
  + outbound materialization. Never calls `sendMessage` or warmup policy.
- `conversation-classification-process.ts` (Stage 13B/13C) — claims classification
  jobs, runs deterministic-then-optional-AI classification, and writes message
  facts plus domain facts. Never sends mail.
- `conversation-policy-process.ts` (Stage 14) — claims policy evaluation jobs
  after domain facts exist and writes append-only policy signals. Never sends
  mail, never mutates warmup/suppression/CRM.

**Target stage**: Stage 12 (warmup worker), Stage 13A (inbound facts poller),
Stage 13B/13C (classification worker), Stage 14 (conversation policy signals),
Stage 15 (integration events recorded with policy; no publisher process),
Stage 16 (authenticated pull consumption; no publisher, ACK, or queue),
Stage 17 (integration pull contract hardening; still no publisher),
Stage 18 (production handoff; outbox immutability; no publisher),
Stage 19 (release freeze / software-engineer handoff; no publisher).

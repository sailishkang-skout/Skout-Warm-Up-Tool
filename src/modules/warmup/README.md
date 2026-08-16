# Warmup

**Responsibility**: the full warmup execution path — `WarmupProfile`
configuration (Stage 7), the state machine, ramp/decision engine, execution
intents, and worker (Stage 8). No real provider send exists yet.

**Core architecture**:

```
Mailbox → Intelligence (health/risk/policy) → Warmup Profile → Warmup Engine
  → Warmup Decision → Warmup Execution Intent → Provider Send Boundary
```

The single most important rule: **the warmup engine never sends
directly**. It produces a decision and, when warranted, a persisted
execution intent — a separate worker claims that intent, re-validates
every safety condition against fresh state, and only then calls
`application/warmup-send-provider.ts`'s port. Warmup code never imports a
concrete provider adapter.

**Boundary**:
- `domain/warmup-state.ts` — the strongly-typed lifecycle
  (`DRAFT`/`ACTIVE`/`PAUSED`/`COOLDOWN`/`COMPLETED`/`STOPPED`/`FAILED`) and
  its exact transition graph. `transitionWarmupState` is pure; every
  transition not in that graph throws — no arbitrary state changes.
- `domain/warmup-session.ts` — the lifecycle aggregate. Deliberately does
  not duplicate mailbox health/risk/eligibility; those are always read
  fresh from `health`/`risk`/`policy` at decision time.
- `domain/warmup-day.ts` — "warmup day" is elapsed UTC calendar days since
  the session started, 1-based, never derived from job/message counts.
  Explicitly UTC (no mailbox timezone concept exists yet), which makes it
  DST-safe by construction.
- `application/ramp-policy.ts` (`calculateWarmupTarget`) — pure, bounded by
  `profile.maximumDailyVolume` and `capacity.maximumDailyVolume` on every
  path; risk level (adjusted by the profile's `riskTolerance`) and
  eligibility gate progression, never a blind daily increase.
- `application/safety-gate.ts` (`evaluateSafetyGate`) — every mandatory
  precondition, evaluated together. Called twice per send: once when a
  decision is generated, and again by the worker immediately before
  calling the provider port (state can change between scheduling and
  execution).
- `application/warmup-execution-policy.ts` (`decideWarmupExecution`) — the
  one authoritative boundary. Every execution decision, from any caller,
  passes through this and only this; it composes the two pure functions
  above rather than duplicating their logic.
- `application/warmup-service.ts` (`WarmupService`) — the orchestrator
  behind `POST/GET /:id/warmup`, `/pause`, `/resume`, `/stop`,
  `/decisions`. Server-authoritative: a caller can never supply risk,
  eligibility, capacity, or volume — every operation fetches a fresh
  `health` assessment itself. Also the only place `WarmupProfile.active`
  is ever flipped (`true` on start, `false` on stop) — Stage 7 deliberately
  left it `false` at creation with no other mutator; `WarmupProfileRepository.setActive`
  is the single method that ever changes it.
- `application/execution-worker.ts` (`ExecutionWorker.processNext`) —
  claims one execution intent (atomic `FOR UPDATE SKIP LOCKED` lease), then
  re-runs the safety gate against freshly-fetched state before ever calling
  the provider port (stale-decision protection). Bounded, jittered retry
  via `domain/retry-policy.ts`.
- `application/warmup-send-provider.ts` (`WarmupSendProvider`) — the
  provider-neutral send boundary. Warmup code depends on this interface
  only, never on a concrete provider adapter directly.
  `infrastructure/unimplemented-warmup-send-provider.ts` is the only
  implementation registered in composition this stage — every call
  reports an honest, non-retryable `PERMANENT_FAILURE` rather than
  fabricating success or silently doing nothing. This means the execution
  worker built in this stage is fully exercised end-to-end (claim → lease
  → safety gate → call the port → record a normalized, terminal result)
  without ever attempting a real network send — "keep execution
  conservative... do not build a high-volume warmup campaign."
- `domain/warmup-execution-intent.ts` — the claimable/leasable record of
  one send attempt, distinct from a decision. `computeIdempotencyKey`
  (`tenant + session + warmupDay + executionSlot`) is enforced unique in
  Postgres, so a duplicate request can never create a duplicate intent.

**No artificial engagement**: nothing in this module fabricates opens,
clicks, replies, conversations, or reputation signals.

**Target stage**: Stage 7 (profile foundation), Stage 8 (state machine,
decision engine, execution intents, worker foundation — **this stage**).
Real provider sending and mailbox-to-mailbox `conversations` are later
stages.

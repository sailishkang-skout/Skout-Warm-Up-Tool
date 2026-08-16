# Warmup

**Responsibility**: the full warmup execution path — `WarmupProfile`
configuration (Stage 7) and its management API (Stage 9), the state
machine, ramp/decision engine, execution intents, and worker (Stage 8),
and the real provider send boundary (Stage 9).

**Core architecture**:

```
Mailbox → Intelligence (health/risk/policy) → Warmup Profile → Warmup Engine
  → Warmup Decision → Warmup Execution Intent → Provider Send Boundary
  → ProviderAdapter.sendMessage → Gmail API / Microsoft Graph
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
  precondition, evaluated together, including `providerCanSend` (from
  `ProviderCapabilities.canSend` — Stage 9). Called twice per send: once
  when a decision is generated, and again by the worker immediately before
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
  left it `false` at creation with no other mutator, and Stage 9's profile
  management API deliberately never exposes `active` as a settable field.
- `application/warmup-profile-service.ts` + `api/warmup-profile-routes.ts`
  (Stage 9) — `GET`/`POST`/`PATCH /:id/warmup/profile`, configuration only.
  Validates ramp strategy/risk tolerance/bounds (including
  `starting <= target <= maximum`, which has no database constraint of its
  own) before writing. Session/decision/intent/lease state is never
  reachable here — `WarmupService` remains the sole authority for those.
- `application/execution-worker.ts` (`ExecutionWorker.processNext`) —
  claims one execution intent (atomic `FOR UPDATE SKIP LOCKED` lease), then
  re-runs the safety gate against freshly-fetched state before ever calling
  the provider port (stale-decision protection). Bounded, jittered retry
  via `domain/retry-policy.ts` — except `SEND_UNKNOWN` (below), which is
  never retried under any circumstance.
- `application/warmup-send-provider.ts` (`WarmupSendProvider`) — the
  provider-neutral send boundary. Warmup code depends on this interface
  only, never on `GmailAdapter`/`Microsoft365Adapter`/`SmtpImapAdapter`
  directly. `infrastructure/adapter-warmup-send-provider.ts` (Stage 9) is
  the one real, provider-agnostic implementation — it resolves the right
  adapter through `ProviderRegistry`, refreshes credentials through the
  same `resolveFreshCredential` `mailbox`/`oauth` already use, and
  generates the message via `domain/warmup-message.ts` immediately before
  sending (never persisted). `infrastructure/unimplemented-warmup-send-provider.ts`
  remains as a safe fallback/test double — never registered in production
  composition anymore, but still useful for exercising the claim/lease
  pipeline without a real provider call.
- `domain/warmup-message.ts` (Stage 9) — the smallest possible message
  model: `{to, subject, body}`, generated deterministically from the
  execution intent's own idempotency key, **addressed to the sending
  mailbox itself**. Self-send is a deliberate, conservative Stage 9
  simplification: no mailbox-to-mailbox partner pool exists yet (that is
  `conversations`, still a Stage 1 stub) and self-send is the only
  recipient this stage can pick without fabricating a partner-selection
  system out of scope or risking mail to an unverified third party.
- `domain/warmup-execution-intent.ts` — the claimable/leasable record of
  one send attempt, distinct from a decision. `computeIdempotencyKey`
  (`tenant + session + warmupDay + executionSlot`) is enforced unique in
  Postgres, so a duplicate request can never create a duplicate intent —
  **this only prevents Skout's own system from double-creating an intent
  for the same slot. It says nothing about whether the *provider* actually
  received a duplicate send.**
- `application/warmup-reconciliation-service.ts` + `api/warmup-reconciliation-routes.ts`
  (hardening pass) — the narrow, provider-agnostic `SEND_UNKNOWN` →
  `REQUIRES_RECONCILIATION` foundation described below. Never imports a
  `ProviderAdapter` and never depends on `WarmupSendProvider`.

**Idempotency and the `SEND_UNKNOWN` limitation (read before touching the
worker or either adapter)**: neither Gmail's `messages.send` nor Microsoft
Graph's `sendMail` accept a client-supplied idempotency token. If a send
request reaches the provider but the response is lost (timeout, connection
reset), this codebase cannot distinguish "never received" from "received
and sent, but we never found out." `ProviderSendStatus`/`ExecutionIntentStatus`
both carry a `SEND_UNKNOWN` value for exactly this case — the execution
worker records it and stops: `claimNext` only ever selects `PENDING` rows,
so a `SEND_UNKNOWN` intent is never automatically retried or reclaimed. It
requires manual reconciliation (checking the mailbox's actual sent
history) before anyone decides what really happened.
Do not "fix" this by making `SEND_UNKNOWN` retryable; that would
reintroduce the duplicate-send risk this design exists to prevent.

**Reconciliation foundation (hardening pass)**:
`application/warmup-reconciliation-service.ts`'s `reconcileUnknownExecution`
is the minimum safe foundation for getting a `SEND_UNKNOWN` intent in front
of a human, not a full reconciliation system:

```
SEND_UNKNOWN → REQUIRES_RECONCILIATION → human/provider-specific
reconciliation → explicit final decision
```

It only performs the first arrow — tenant-scoped, idempotent (a repeat
call returns the same result rather than erroring or re-auditing), and
provider-agnostic (it never imports a `ProviderAdapter` and never calls
`WarmupSendProvider.sendWarmupMessage`, so it structurally cannot resend).
`REQUIRES_RECONCILIATION` is exactly as terminal and non-retryable as
`SEND_UNKNOWN` itself — `claimNext` still only selects `PENDING` rows.
Exposed at `POST /:id/warmup/executions/:intentId/reconcile`
(`api/warmup-reconciliation-routes.ts`) — administrative/internal, behind
the same tenant authentication as every other route in this service (there
is no separate admin credential tier yet). **Resolving a
`REQUIRES_RECONCILIATION` intent to a final `SENT`/`FAILED` — actually
checking the mailbox's sent history and deciding what really happened —
is still a human/operational process with no tooling built for it yet.**

**No artificial engagement**: nothing in this module fabricates opens,
clicks, replies, conversations, or reputation signals. The generated
warmup message is short, generic, non-promotional, and self-addressed —
never a campaign, never sent to an unverified third party.

**Target stage**: Stage 7 (profile foundation), Stage 8 (state machine,
decision engine, execution intents, worker foundation), Stage 9 (real
Gmail/Microsoft 365 sending, profile management API, `SEND_UNKNOWN`
handling). Real SMTP/IMAP sending and mailbox-to-mailbox `conversations`
are later stages.

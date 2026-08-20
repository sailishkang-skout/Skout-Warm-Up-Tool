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
  Deliberately still UTC even after Stage 12 added a per-mailbox timezone
  (`mailbox.timezone`) — the two are orthogonal concerns: "warmup day"
  answers "has this session's ramp progressed to its next daily target,"
  which only needs a stable, DST-safe day boundary; *when within that day*
  a send is actually allowed to happen is `domain/send-window.ts`'s job
  (below), evaluated against the mailbox's real local time. Splitting them
  keeps each one simple and avoids a UTC-day-count function that would
  otherwise need to reason about DST-shifted local calendar boundaries.
- `application/ramp-policy.ts` (`calculateWarmupTarget`) — pure, bounded by
  `profile.maximumDailyVolume` and `capacity.maximumDailyVolume` on every
  path; risk level (adjusted by the profile's `riskTolerance`) and
  eligibility gate progression, never a blind daily increase. This is also
  Stage 10's adaptive layer in its entirety: reputation feeds `risk` as an
  extra factor source (see `risk/README.md`), and this function already
  reacts to `risk.riskLevel` — no second, parallel "adaptive capacity"
  policy was built, since one would only duplicate this one (Stage 10
  spec section 16: "do not create a second decision engine"). Stage 10
  did add one behavior fix here: recovering from a HIGH/CRITICAL-risk
  reduction back to LOW risk now climbs by at most one ramp step per day
  (`previousTarget + step`, capped at the day-based trajectory) instead of
  snapping straight back to it — "recovery must also be gradual" (Stage 10
  spec section 14). This only changes behavior when `previousTarget` sits
  below the day-based trajectory (i.e. something reduced it); the ordinary
  steady-state path is numerically identical to before.
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
- `domain/warmup-message.ts` (Stage 9, Stage 20 `toAddress`) — the smallest possible message
  model: `{to, subject, body}`, generated deterministically from the
  execution intent's own idempotency key. **Default remains self-send**
  (`to` = sending mailbox). Stage 20/21 may pass `toAddress` when
  `WARMUP_NETWORK_ROUTING_MODE` is `prefer` or `require`; mode `off`
  never queries the network. See `docs/WARMUP_NETWORK.md`.
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

## Scheduling (Stage 12)

Before Stage 12, nothing in production actually called
`ExecutionWorker.processNext()` more than once, and nothing re-triggered a
session's *next* daily decision past day 1 — both were only exercised by
tests calling the relevant function directly. Stage 12 closes that gap with
the smallest addition that reuses everything above unchanged:

```
Worker process (src/workers/execution-worker-process.ts)
  → WarmupScheduler.runTick (application/warmup-scheduler.ts)
      1. reclaim expired leases
      2. advance ACTIVE sessions that are due → WarmupService.advanceDailyWarmup
      3. drain PENDING intents → ExecutionWorker.processNext (unchanged, loop to empty)
```

**The scheduler answers "when," never "is it safe."** It contains no
risk/reputation/safety-gate/execution-policy logic of its own and never
imports a `ProviderAdapter` — every one of its three steps delegates to
already-existing, already-tested logic. `docker-compose.yml`/`package.json`
list `bullmq` as a dependency and `scheduling/README.md` originally
described a BullMQ-based design, but Stage 8 never actually built it that
way — `warmup_execution_intents`' `FOR UPDATE SKIP LOCKED` claim/lease
model *is* the real execution infrastructure, already concurrency-proven
(`tests/db/warmup-concurrency.test.ts`). Stage 12 deliberately did not
introduce BullMQ on top of it: doing so would mean either a queue used only
to trigger a timer, or re-implementing claiming/retry/idempotency as
BullMQ jobs — duplicating this already-working engine. See
`scheduling/README.md` for the corrected module boundary.

- **`application/warmup-scheduler.ts`** (`WarmupScheduler.runTick`) — one
  full pass. Advancing a due session calls `WarmupService.advanceDailyWarmup`
  (below), never a hand-rolled pause/resume simulation. A single mailbox's
  failure is logged and skipped, never allowed to block every other
  tenant's tick.
- **`application/warmup-service.ts`**'s new `advanceDailyWarmup` — the
  scheduler-facing counterpart to `startWarmup`/`resumeWarmup`, reusing the
  exact same private `evaluateAndCommit` those two already call (Stage 12
  spec: "do not duplicate `evaluateAndCommit` logic"). Requires the session
  to already be `ACTIVE` and re-verifies `computeWarmupDay` itself before
  doing anything, rather than trusting the scheduler's own due-check.
- **`application/warmup-session-repository.ts`**'s new
  `findActiveSessionsDueForDecision` — a cheap, cross-tenant SQL pre-filter
  (`last_decision_at` before today's UTC midnight); the caller still
  re-derives the authoritative answer via `computeWarmupDay` per candidate,
  never duplicating that domain calculation in SQL.
- **Lease safety** — see `application/execution-worker.ts`'s top-of-file
  doc comment for the full analysis. Short version: a legitimate send can
  still exceed the 60-second lease even though both the credential-refresh
  fetch and the provider send call are now bounded (Stage 12.1 —
  `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`/`SEND_TIMEOUT_MS` respectively,
  independently configured), since other sources of slowness remain
  possible (a GC pause, a slow DB round trip) — so a naive "reclaim once
  expired" sweep alone would still be unsafe on its own.
  `execution-worker.ts` renews its held lease every 20s while a claim is
  in flight (`renewLease`), as defense-in-depth beyond the timeouts
  themselves; `postgres-warmup-execution-intent-repository.ts`'s
  `reclaimExpiredLeases` only ever finds genuinely dead workers under
  normal operation. **Guarantee**: at-least-once execution with a
  heartbeat-enforced reclaim boundary — not exactly-once (nothing could be,
  without a provider-side idempotency token; see the `SEND_UNKNOWN`
  section above). A reclaimed intent whose `attemptCount` has already
  reached `domain/retry-policy.ts`'s `MAX_ATTEMPTS` is reclaimed straight
  to `FAILED`, not back to `PENDING` — otherwise a persistently-crashing
  worker could cycle an intent between `CLAIMED` and reclaimed-`PENDING`
  forever, a failure mode reclaim itself would introduce if left unbounded.
- **Credential-refresh timeout (Stage 12.1)** — `resolveFreshCredential`
  (`providers/application/resolve-fresh-credential.ts`) now distinguishes a
  bounded, retryable refresh failure (timeout or transient network error —
  `ProviderError` with `retryable: true`) from a genuinely dead refresh
  token (`invalid_grant` or similar): only the latter revokes the
  credential. The former rethrows, and
  `infrastructure/adapter-warmup-send-provider.ts` — the one caller whose
  result feeds `domain/retry-policy.ts` — catches it and returns a
  retryable `TEMPORARY_FAILURE` `ProviderSendResult` rather than a
  terminal `AUTH_FAILED`, so a network blip during token refresh no longer
  forces a mailbox through full OAuth re-consent, and no longer terminally
  fails an otherwise-healthy intent. `mailbox-service.ts`'s own callers
  (`connectMailbox`/`getConnectionHealth`/`getBaseline`) need no new
  handling — they already document that they throw `ProviderError`, and
  the global error-handler plugin already converts any `AppError`
  subclass to a safe response.
- **`domain/send-window.ts`** — mailbox-local send windows/quiet hours,
  built on `shared/time` (`Intl`-backed, no new dependency — see that
  module's doc comment). A `WarmupProfile` may configure
  `windowStartMinute`/`windowEndMinute` (minutes since local midnight,
  evaluated against `mailbox.timezone`); unconfigured means unrestricted,
  preserving exactly the pre-Stage-12 behavior. Checked twice, matching
  this module's existing "check twice" pattern for safety-relevant state:
  once at intent-creation time (`warmup-service.ts` sets `scheduledFor` to
  the window's next opening, so `claimNext` doesn't even consider a
  window-closed intent in the common case) and again by
  `execution-worker.ts` at claim time, *before* the risk/safety-gate
  re-check (defense-in-depth against drift — e.g. a backlogged worker
  claiming after the window has since closed). A window-blocked claim is
  **deferred** (`deferExecution` — re-queued `PENDING` with a fresh
  `scheduledFor`), never cancelled, so a closed window never costs the
  day's warmup volume. This is a *time* check only, never a safety
  decision — `evaluateSafetyGate` is untouched and still runs afterward.
- **`src/workers/execution-worker-process.ts`** — the long-running process
  entrypoint (`npm run worker:dev` / `npm run start:worker`, separate from
  the HTTP API process, same pattern as `server.ts`). A strict
  await-sequential loop (never `setInterval` for the tick cadence itself,
  so ticks can never overlap), 30s between ticks, interruptible on
  `SIGTERM`/`SIGINT` so shutdown doesn't wait out a full poll interval. A
  tick already in progress always finishes naturally — every claimed
  intent reaches a terminal or re-queued state before `runTick` returns —
  so there is no shutdown-specific lease release; a process killed mid-tick
  relies on the same lease-expiry + reclaim path any other crash does.

**Target stage**: Stage 7 (profile foundation), Stage 8 (state machine,
decision engine, execution intents, worker foundation), Stage 9 (real
Gmail/Microsoft 365 sending, profile management API, `SEND_UNKNOWN`
handling), Stage 12 (scheduler, lease reclaim/renewal, mailbox timezone,
send windows). Real SMTP/IMAP sending remains out of scope. Conversation
facts live in `modules/conversations` (Stages 13A–18) and do not send mail.
Stage 20 warmup-network routing is **opt-in**; self-send remains the default.
Tenant sending-identity pools (`warmup-pool`, `docs/WARMUP_POOL_ROTATION.md`)
are a separate optional layer and do not change this worker.

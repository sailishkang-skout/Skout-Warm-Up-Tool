# Skout Email Warmup Service — Architecture

Standalone microservice. Does not import, copy, or depend on code from any
other Skout repository. Independently deployable and operable; may later
integrate with Skout Email Intelligence, Skout outbound/campaign systems, the
Skout main application, n8n, or external applications — none of those are
dependencies of this service.

## Product philosophy

`OBSERVE → ANALYZE → SCORE → PREDICT → DECIDE → ACT → OBSERVE AGAIN`

End-to-end pipeline this service implements:

`MAILBOX → WARMUP → OPTIONAL WARMUP NETWORK → PROVIDER SEND → INBOUND → CONVERSATIONS → CLASSIFICATION → POLICY → INTEGRATION EVENTS → EXTERNAL MAIN PLATFORM (pull)`

Warmup owns volume/ramp/schedule/safety/risk/reputation/intents/retry/`SEND_UNKNOWN`.
Default `WARMUP_NETWORK_ROUTING_MODE=off` (self-send, no network lookup). When
opted in, the network only picks a partner **recipient**. Tenant **warmup-pool**
(030) is a separate optional **sender** selector; the scheduler is not wired
to rotate through pools.

Warmup volume is never a fixed global schedule. It is the output of a policy
decision computed from observed health, risk, and provider signals. See
`src/modules/policy/README.md` and `src/modules/warmup/README.md`.

## Core architecture

TypeScript (strict) + Node.js + Fastify + PostgreSQL + Redis. Local
Compose (`docker-compose.yml`) runs Postgres and Redis only (host ports
5433/6380). There is no application Dockerfile or process manager in this
repository.
Clean-architecture module boundaries without unnecessary abstraction: each
domain module is split into `domain/` (types, pure logic), `application/`
(services/use-cases), `infrastructure/` (repositories, adapters), `api/`
(Fastify routes). Dependencies flow `api → application → domain`, with
`infrastructure` implementing interfaces defined in `domain`/`application`
(ports-and-adapters). `shared/` holds domain-agnostic building blocks (config,
logger, errors, db, redis, time, http, observability) and never imports from
`modules/*`. **Correction (Stage 12 / 19):** warmup scheduling is
Postgres-native. `bullmq` is **not** a runtime dependency. `shared/queue/`
remains an empty directory.

## Directory structure

```
src/
  app.ts                     buildApp(): FastifyInstance — testable, no listen()
  server.ts                  process bootstrap: buildApp() + listen()
  modules/
    tenancy/                 Tenant aggregate, tenant lookup
    auth/                    API keys, request → TenantId resolution
    mailbox/                 Mailbox aggregate + onboarding state machine (Stage 12: + IANA `timezone`)
    providers/                MailboxProvider interface + gmail/microsoft365/smtp-imap adapters;
                              Gmail/Microsoft 365 also implement real sendMessage (Stage 9)
    domain-intelligence/     SPF/DKIM/DMARC/MX/DNS signal evaluation (Redis → Postgres → DNS)
    warmup/                  WarmupProfile (+ management API) + warmup state machine,
                              ramp/decision engine, execution intents, claim-based worker, the
                              real provider send boundary, and (Stage 12) the scheduler that
                              actually drives daily progression + continuous execution — see
                              warmup/README.md, in particular its SEND_UNKNOWN/idempotency
                              limitation and its Stage 12 "Scheduling" section. Default send
                              is still self-send; Stage 20 network routing is opt-in.
    warmup-network/          Stage 20 schema + Stage 21 productionization: global partner
                              recipient routing (opt-in). Default off. Not a live fleet. See
                              docs/WARMUP_NETWORK.md.
    warmup-pool/             Stage 20 identity: tenant-owned sending-mailbox pools +
                              deterministic selector. Optional; sessions stay per-mailbox.
                              Distinct from warmup-network. See docs/WARMUP_POOL_ROTATION.md.
    conversations/           Stage 13A–19: normalized EMAIL conversations/messages,
                             inbound poller, outbound materializer, classification
                             facts, domain facts, policy signals, and a transactional
                             integration-event outbox. No sequences, LinkedIn, CRM,
                             suppression storage, or send.
    scheduling/               Superseded by Stage 12's Postgres-native design in `warmup` —
                              see scheduling/README.md's correction
    delivery-events/         Normalized delivery-event ingestion + idempotent persistence +
                              rolling-window aggregation (Stage 10)
    health/                  Mailbox health assessment (6 dimensions) + the cross-module
                              orchestrator that assembles one AssessmentSnapshot per refresh
                              (Stage 10: also computes reputation, checks staleness invalidation)
    risk/                    Risk engine — weighted score + level, computed from health output
                              (Stage 10: + optional reputation-derived factors; Stage 11: + provider-
                              and domain-scoped reputation factors, own lower-weighted allowlists)
    reputation/              Mailbox-level, delivery-evidence reputation assessment (Stage 10);
                              provider-level and domain-level reputation, aggregated across every
                              mailbox on that provider/domain for the tenant (Stage 11) — see
                              reputation/README.md
    policy/                  Warmup eligibility decision + capacity recommendation, computed
                              from health + risk output
    audit/                   Append-only audit event log
  shared/
    config/  logger/  errors/  types/  db/  redis/  time/  http/  observability/
    (queue/ remains an empty directory — see the BullMQ correction above)
  plugins/                   Fastify plugin wiring (auth, error handling, request context)
  workers/                   Standalone worker process entrypoints:
                              execution-worker-process.ts (warmup),
                              inbound-poller-process.ts,
                              conversation-classification-process.ts,
                              conversation-policy-process.ts
migrations/                  SQL migrations (hand-written, no ORM)
tests/
  unit/
  db/                            live Postgres/Redis (`npm run test:db`)
  integration/                   Fastify app smoke tests
docs/
  ARCHITECTURE.md
  SOFTWARE_ENGINEER_HANDOFF.md   primary engineer document
  INTEGRATION_CONTRACT.md        frozen pull API
  PRODUCTION_HANDOFF.md          operations
  ENVIRONMENT_REFERENCE.md       env vars
  WARMUP_NETWORK.md              global partner recipients (029)
  WARMUP_POOL_ROTATION.md        tenant sending-identity pools (030)
  DISASTER_RECOVERY.md
  PRIVACY.md
  PROVIDER_CERTIFICATION_RUNBOOK.md
```

Each `modules/<name>/README.md` documents that module's responsibility,
boundary (what it owns, what it must never reach into), and target
implementation stage. Read those before adding code to a module.

**Decision pipeline ownership** (`Mailbox → Signals → Evidence → Health →
Risk → Eligibility → Capacity`, landed in Stage 7 — earlier than this
document's original Stage 11/12 targets below, which predate that
decision): `domain-intelligence` owns DNS facts about a sending domain;
`health` owns raw-signal collection, health assessment, and the
orchestrator that ties the whole pipeline into one persisted
`AssessmentSnapshot`; `risk` owns risk scoring computed from health
output; `policy` owns the two authoritative decisions (warmup eligibility,
capacity recommendation) computed from health + risk output; `warmup` owns
everything from `WarmupProfile` configuration through the execution
foundation described below, plus (Stage 12) the scheduler that actually
drives it continuously; `scheduling` is superseded by that Postgres-native
design — see its README's correction. None of these modules call back "up"
the chain or into each other's infrastructure — see each module's own
README for its exact dependency direction.

**Warmup execution layer** (Stage 8, `warmup` module — extends the pipeline
above: `... → Capacity → Warmup Profile → Warmup Engine → Warmup Decision →
Warmup Execution Intent → Provider Send Boundary`):

- **ENGINE DECIDES** — `application/warmup-execution-policy.ts`
  (`decideWarmupExecution`) is the one authoritative boundary. It composes
  `application/ramp-policy.ts` (bounded, risk/eligibility-adaptive daily
  volume) and `application/safety-gate.ts` (every mandatory precondition)
  and produces a `WarmupDecision` — `PROCEED`/`REDUCE`/`PAUSE`/`BLOCK`/
  `REVIEW`. No API controller, scheduler, worker, or provider adapter ever
  decides independently.
- **Warmup State Machine** — `domain/warmup-state.ts`. Seven states
  (`DRAFT`/`ACTIVE`/`PAUSED`/`COOLDOWN`/`COMPLETED`/`STOPPED`/`FAILED`), an
  explicit transition table, pure `transitionWarmupState`. Persisted with
  one open (non-terminal) session per mailbox enforced by a Postgres
  partial unique index, not application code alone.
- **Decision Layer** — every `WarmupDecision` is append-only
  (`warmup_decisions`), carrying the reason codes/reasons, the risk/
  eligibility it was computed from, a reference to the exact `health`
  `AssessmentSnapshot` used, and an immutable `profileSnapshot` (Stage 8
  spec section 23) so a later profile edit can never reinterpret a
  historical decision.
- **Execution Intent** — `domain/warmup-execution-intent.ts`. The
  claimable/leasable record of one send attempt, distinct from the
  decision that authorized it. Deterministic idempotency key (`tenant +
  session + warmupDay + executionSlot`) enforced unique in Postgres —
  duplicate requests can never create duplicate intents.
- **WORKER EXECUTES** — `application/execution-worker.ts`
  (`ExecutionWorker.processNext`). Atomically claims one `PENDING` intent
  (`FOR UPDATE SKIP LOCKED`), then re-runs the full safety gate against
  freshly-fetched session/mailbox/assessment state — never trusting "it was
  valid when scheduled" (**Stale Decision Protection**: a session paused,
  or risk/eligibility that materially worsened, after the decision was
  made cancels the intent instead of sending).
- **Idempotency & Leases** — `leaseOwner`/`leaseExpiresAt`/`attemptCount`
  back the claim model; two workers can never successfully claim the same
  `PENDING` intent. **Retry** is bounded and classified
  (`domain/retry-policy.ts`): only `RATE_LIMITED`/`TEMPORARY_FAILURE` ever
  retry, capped at 5 attempts, with capped+jittered backoff.
- **Pause** — a session moved to `PAUSED`/`COOLDOWN` after an intent was
  created still has that intent re-checked (and cancelled, never executed)
  by the worker's live safety-gate re-check above — the claim step itself
  does not need to know about session state for this to be safe.
- **PROVIDER ADAPTER SENDS** — `application/warmup-send-provider.ts`
  (`WarmupSendProvider`) is the provider-neutral boundary warmup code
  depends on; it never imports a concrete provider adapter directly. Since
  Stage 9, `infrastructure/adapter-warmup-send-provider.ts` is the one
  real, provider-agnostic implementation registered in composition — it
  resolves the mailbox's `ProviderAdapter` via `ProviderRegistry`,
  refreshes its credential via `providers/application/resolve-fresh-credential.ts`
  (the same function `mailbox`/`oauth` already use), and calls the
  adapter's own `sendMessage`. `infrastructure/unimplemented-warmup-send-provider.ts`
  remains as a safe fallback/test double, no longer used in production
  composition.

### Provider send boundary, idempotency, and `SEND_UNKNOWN` (Stage 9)

`ProviderAdapter.sendMessage` (optional, like `oauth` — `providers/domain/provider-adapter.ts`)
is real on `GmailAdapter`/`Microsoft365Adapter`, absent on `SmtpImapAdapter`
(no safe implementation exists yet — never faked). It never throws for a
provider-side outcome; every branch (`ACCEPTED`/`AUTH_FAILED`/`RATE_LIMITED`/
`TEMPORARY_FAILURE`/`PERMANENT_FAILURE`/`SEND_UNKNOWN`) is a normal return
value the caller classifies.

**Exactly-once delivery is not guaranteed, and cannot be with these
provider APIs.** Neither Gmail's `messages.send` nor Microsoft Graph's
`sendMail` accept a client-supplied idempotency token. If the HTTP request
reaches the provider but this process never receives the response
(timeout, connection reset), there is no way to know whether the provider
actually sent the message. `SEND_UNKNOWN` is that state:

- The execution worker (`application/execution-worker.ts`) records it as
  a distinct, terminal `ExecutionIntentStatus` — never `FAILED`, and
  checked *before* `classifyRetry` so it can never be routed into the
  generic retry path by a future change to that function.
- `claimNext` only ever selects `PENDING` rows, so a `SEND_UNKNOWN` intent
  is never automatically retried or reclaimed by any worker.
- This is an at-least-possible-duplicate / at-least-possible-never-sent
  state requiring manual reconciliation (checking the mailbox's actual
  sent history). See "Unknown-send reconciliation foundation" below for
  the minimum safe scaffolding added for that (hardening pass) — it is
  still not a full reconciliation system.

What Stage 9 *does* guarantee: Skout's own system will never create two
execution intents for the same `(session, warmupDay, executionSlot)` —
`computeIdempotencyKey` is enforced unique in Postgres. That is
idempotency at the intent-creation layer, not at the provider-delivery
layer; the two are deliberately not conflated.

`OAuth token refresh` happens automatically before every send attempt via
`resolveFreshCredential` (refresh within 60s of expiry; a dead refresh
token is revoked, never silently retried forever, and the mailbox's
authentication health degrades naturally through the existing `health`
pipeline on the next assessment). No new OAuth implementation was
introduced.

### Unknown-send reconciliation foundation (hardening pass)

`SEND_UNKNOWN` had no operational path out of it — a row just sat in
`warmup_execution_intents` for direct database inspection. This adds the
minimum safe scaffolding, not a full reconciliation system:

```
SEND_UNKNOWN → REQUIRES_RECONCILIATION → human/provider-specific
reconciliation → explicit final decision
```

`application/warmup-reconciliation-service.ts`'s `reconcileUnknownExecution`
performs only the first arrow: it loads the intent, verifies tenant
ownership, confirms the status is `SEND_UNKNOWN` (or already
`REQUIRES_RECONCILIATION`, for idempotency), and moves it to
`REQUIRES_RECONCILIATION` via `WarmupExecutionIntentRepository.markRequiresReconciliation`
— an atomic, tenant-scoped Postgres `UPDATE ... WHERE status = 'SEND_UNKNOWN'`
(migration 017 widens the same `status` CHECK constraint migration 016
already widened once, again without editing 001-016). It never calls
`WarmupSendProvider.sendWarmupMessage`, never sets a `SENT` status itself,
and never retries — structurally incapable of the duplicate-send risk
`SEND_UNKNOWN` exists to prevent, because it has no dependency on any
provider or send port at all. Every request is recorded as a
`WARMUP_RECONCILIATION_REQUESTED` audit event (ids/enums only, once per
actual transition — a repeat idempotent call does not re-audit). Exposed
administratively at `POST /:id/warmup/executions/:intentId/reconcile`,
authenticated the same way every other route in this service is (there is
no separate admin credential tier yet). Resolving `REQUIRES_RECONCILIATION`
to a final `SENT`/`FAILED` — actually checking the mailbox's sent history —
remains a manual, un-tooled operational step.

### Warmup scheduling, lease safety, and send windows (Stage 12)

```
Worker process (src/workers/execution-worker-process.ts)
  → WarmupScheduler.runTick (warmup/application/warmup-scheduler.ts)
      1. reclaim expired leases
      2. advance ACTIVE sessions that are due → WarmupService.advanceDailyWarmup
      3. drain PENDING intents → ExecutionWorker.processNext (unchanged)
```

Before this stage, nothing in production actually called
`ExecutionWorker.processNext()` more than once, and nothing re-triggered a
session's next daily decision past day 1 — both only ran inside tests
calling the relevant function directly. The scheduler closes that gap by
answering "when," never "is it safe": it contains no risk/reputation/
safety-gate/execution-policy logic of its own, never imports a
`ProviderAdapter`, and its three responsibilities all delegate to
already-existing, already-tested logic (`WarmupService.advanceDailyWarmup`
reuses the same private `evaluateAndCommit` `startWarmup`/`resumeWarmup`
already call; `ExecutionWorker.processNext` is entirely unmodified in its
own decision logic).

- **Lease safety analysis**: the critical section between claiming an
  intent and recording its result can still legitimately exceed the
  60-second lease even though both network calls in it are now bounded —
  the provider send call (`SEND_TIMEOUT_MS = 15_000` in both Gmail/
  Microsoft 365 adapters) and, since Stage 12.1,
  `resolveFreshCredential`'s OAuth token-refresh fetch
  (`PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`, independently configured,
  default 10s — see "Credential-refresh timeout hardening" below) — since
  other sources of slowness (a GC pause, a slow DB round trip) remain
  possible. A naive "reclaim once `lease_expires_at < now()`" sweep alone
  would therefore still be unsafe on its own. `execution-worker.ts` renews
  its held lease every 20 seconds while a claim is in flight
  (`WarmupExecutionIntentRepository.renewLease`), as defense-in-depth
  beyond the timeouts; the `reclaimExpiredLeases` sweep only ever finds
  genuinely dead workers under normal operation. **Guarantee provided**:
  at-least-once execution with a heartbeat-enforced reclaim boundary, not
  exactly-once — nothing could guarantee that without a provider-side
  idempotency token (see `SEND_UNKNOWN` above, unchanged). A reclaimed
  intent already at `retry-policy.ts`'s `MAX_ATTEMPTS` goes straight to
  `FAILED`, not back to `PENDING` — otherwise reclaim itself would let a
  persistently-crashing worker cycle an intent forever, a failure mode
  that didn't exist before
  reclaim did.
- **Due-session advancement**: `WarmupSessionRepository.findActiveSessionsDueForDecision`
  is a cheap SQL pre-filter (`last_decision_at` before today's UTC
  midnight, a new partial index); `WarmupService.advanceDailyWarmup`
  re-derives the authoritative answer via the existing, unmodified
  `computeWarmupDay` per candidate before committing anything — the SQL
  layer never duplicates that domain calculation. Concurrent scheduler
  ticks advancing the same session never create duplicate execution
  intents: `commitExecutionVolume`'s existing atomic
  `committed_volume_today + volume <= current_daily_target` guard (Stage
  8, unchanged) already makes a second concurrent commit for a
  fully-committed day impossible — no new lock was needed.
- **Mailbox timezone and send windows**: `mailboxes.timezone` (IANA
  identifier, defaults to `"UTC"`) and `warmup_profiles.window_start_minute`/
  `window_end_minute` (both-or-neither, minutes since local midnight) are
  new, additive columns (migration 021). `warmup/domain/send-window.ts`
  evaluates them via `shared/time` — `Intl.DateTimeFormat`-backed, not a
  new dependency (see that module's doc comment for why this codebase
  chose the platform's built-in ICU over adding a timezone library) and
  not manual offset arithmetic anywhere. Checked twice: at intent-creation
  time (`scheduledFor` is set to the window's next opening, so `claimNext`
  doesn't even consider a window-closed intent in the common case) and
  again by the execution worker at claim time, before the risk/safety-gate
  re-check, as defense-in-depth against drift. A window-blocked claim is
  *deferred* (re-queued `PENDING`), never cancelled — a closed window never
  costs the day's warmup volume. This is a time check only; `evaluateSafetyGate`
  is untouched and still runs afterward for every claim.
- **Worker process**: `src/workers/execution-worker-process.ts`, a
  standalone entrypoint (`npm run worker:dev` / `start:worker`) separate
  from the HTTP API process. A strict await-sequential loop — never
  `setInterval` for the tick cadence — so ticks can never overlap; 30
  seconds between ticks by default, interruptible on `SIGTERM`/`SIGINT` so
  shutdown doesn't wait out a full poll interval. No shutdown-specific
  lease release is needed: every claimed intent already reaches a terminal
  or re-queued state before `runTick` returns, and a process killed
  mid-tick relies on the same lease-expiry + reclaim path any other crash
  does.
- **What this stage deliberately did not build**: BullMQ (see the Core
  architecture correction above), a generic `scheduled_actions`/job table
  (`warmup_sessions` + `warmup_execution_intents` already are the durable
  scheduling state), a second capacity/decision engine, or a metrics
  framework (structured logging + the audit trail remain sufficient, same
  as every prior stage).

### Credential-refresh timeout hardening (Stage 12.1)

Stage 12's own completion report flagged one remaining limitation: the
OAuth access-token refresh network call
(`providers/application/resolve-fresh-credential.ts` →
`adapter.oauth.refreshAccessToken`) had no timeout, unlike the provider
send call it can precede. Stage 12.1 closes it, narrowly:

- **Bounded**: both `GmailAdapter`/`Microsoft365Adapter`'s
  `refreshAccessToken` now pass `signal: AbortSignal.timeout(refreshTimeoutMs)`
  to the token-endpoint fetch — the same mechanism (`AbortSignal.timeout`)
  their existing `SEND_TIMEOUT_MS` already used, on an independent budget.
  Configurable via `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`
  (`shared/config/schema.ts`, default 10s — long enough for a normal
  token-endpoint round trip, short enough to keep the worst-case
  refresh-then-send critical section safely under the execution worker's
  60-second lease even without lease-heartbeat renewal), threaded through
  `AppConfig.providers.credentialRefreshTimeoutMs` and
  `composition/build-services.ts` — never a raw `process.env` read inside
  adapter code.
- **Classified, not swallowed**: `AbortSignal.timeout` firing rejects with
  a `DOMException` named `"TimeoutError"`, verified distinct from a plain
  network failure — each adapter now throws `ProviderError` with
  `details: { reason: "timeout" }` for that case, versus
  `{ reason: "network_failure" }` for any other transient failure and
  `{ reason: parsed.error }` for a genuine OAuth rejection (unchanged,
  e.g. `invalid_grant`). All three stay `ProviderError` — no new error
  class was introduced.
- **The real fix was in `resolveFreshCredential`, not just the adapters**:
  before this stage, *any* refresh failure — including what would now be
  a timeout — was caught by a blanket `catch` that always revoked the
  credential, on the reasoning that the refresh token itself must be dead.
  That was already slightly wrong before Stage 12.1 (a network blip during
  refresh isn't proof the refresh token is invalid) but became actively
  harmful once refresh calls could time out more routinely under load:
  revoking a healthy mailbox's credential over a slow network would force
  it through full OAuth re-consent for no reason. `resolveFreshCredential`
  now inspects the caught error — a retryable `ProviderError` (timeout or
  network failure) rethrows instead of revoking; only a non-retryable one
  (`invalid_grant` or unrecognized) still revokes, unchanged.
- **Propagation**: `resolveFreshCredential`'s three other callers
  (`mailbox-service.ts`'s `connectMailbox`/`getConnectionHealth`/
  `getBaseline`) already document that they throw `ProviderError`, and the
  global error-handler plugin already converts any `AppError` subclass to
  a safe response — no changes needed there. The one caller that must
  never throw (`WarmupSendProvider.sendWarmupMessage`'s established
  contract) is `warmup/infrastructure/adapter-warmup-send-provider.ts`,
  which now catches the retryable `ProviderError` specifically and returns
  a `TEMPORARY_FAILURE` `ProviderSendResult` (`retryable: true`) instead —
  flowing through the *existing*, unmodified `classifyRetry`/`recordResult`
  path in `execution-worker.ts`, never a special case. Anything other than
  that one classified case is deliberately rethrown, not swallowed.
- **Lease interaction**: the existing Stage 12 lease-heartbeat renewal is
  unchanged and still runs — see the Stage 12 section above, updated to
  reflect that both network calls in the critical section are now bounded
  (heartbeat remains as defense-in-depth against other sources of
  slowness, not this specific gap anymore).
- **What this stage deliberately did not build**: no OAuth/provider-adapter/
  credential-storage/scheduling/lease-management/retry-policy redesign, no
  BullMQ, no new HTTP framework, no new metrics framework, no changes to
  warmup policy/risk/reputation/safety-gate/mailbox-scheduling/send-window
  behavior.

### Warmup Profile management API (Stage 9)

`GET`/`POST`/`PATCH /api/v1/mailboxes/:id/warmup/profile`
(`warmup/api/warmup-profile-routes.ts`, `application/warmup-profile-service.ts`)
manage `WarmupProfile` configuration (target/starting/maximum daily
volume, ramp strategy, risk tolerance, pause conditions) only.
`tenantId`/`mailboxId` are always server-derived; `active`,
session/decision/intent/lease state are never reachable through this API
— `WarmupService`'s `start`/`pause`/`resume`/`stop` remain the sole
authority for those (Stage 8, extended by Stage 9's `setActive` calls
from `startWarmup`/`stopWarmup`).

### Adaptive warmup feedback loop (Stage 10, extended Stage 11)

```
Provider Send → Delivery Event → Normalized Event → Mailbox Reputation
  → Provider/Domain Reputation (Stage 11) → Risk factors
  → (existing) Risk Assessment → (existing) Ramp Policy
  → (existing) Safety Gate → (existing) Warmup Execution Policy
```

The right-hand half of that chain is **entirely unmodified Stage 7/8
code** — `application/ramp-policy.ts` already reacted to `risk.riskLevel`
(CRITICAL → zero/pause, HIGH → reduce from the previous day, MEDIUM →
half-speed progression, LOW → normal progression), so feeding it better
risk input via `reputation` makes the whole system adaptive without a
second, parallel "adaptive capacity" policy (Stage 10 spec section 16: "do
not create a second decision engine"). The one genuine behavior change
Stage 10 made to existing code is `ramp-policy.ts`'s LOW-risk branch: it no
longer snaps straight back to the day-based trajectory when recovering
from a previous reduction — see `warmup/README.md`'s ramp-policy entry.

- **`delivery-events`** (new module) — `POST /api/v1/internal/delivery-events`
  ingests one already-normalized `DeliveryEvent`
  (`DELIVERED`/`BOUNCED`/`FAILED`/`THROTTLED`/`DEFERRED`/`REJECTED`/
  `COMPLAINT`/`UNKNOWN`), idempotent by `dedupeKey` (`tenant + provider +
  providerEventId`, or a documented fallback identity when no provider
  event id exists — see that module's README). No real Gmail/Microsoft
  webhook endpoint exists yet (no signature verification) — this
  authenticated internal endpoint is the documented, deliberate fallback
  Stage 10 spec section 5 allows, and the exact shape a future webhook
  handler would normalize a provider payload into. Never manipulates
  warmup volume directly; only persists evidence, marks the mailbox's
  intelligence stale, and audits.
- **`reputation`** (module scope widened this stage — see its README's
  scope note) — `application/reputation-policy.ts`'s `evaluateReputation`
  is a pure function over three rolling windows (last 24h / last 7d /
  lifetime, computed by `delivery-events`' aggregation query) plus an
  internal prior-24h window used only for trend detection. Produces a
  `ReputationStatus` (`EXCELLENT`/`HEALTHY`/`DEGRADED`/`POOR`/`CRITICAL`/
  `UNKNOWN`), per-metric `TrendDirection`s, and explainable `factors` —
  every rate is `"UNKNOWN"`, never a fabricated `0`, below a minimum
  sample size, and a genuinely triggered factor (e.g. a real complaint,
  gated by absolute count) always takes priority over that "not enough
  evidence" gate. Persisted append-only
  (`migrations/019_create_reputation_assessments.sql`); `GET
  /:id/reputation` / `GET /:id/reputation/history` expose it read-only.
  `reputation` never decides risk or volume itself — `risk` reads its
  `factors`, nothing else.
- **`risk`** (extended) — `RiskPolicyInput.reputation` is optional; when
  present, `evaluateRisk` re-weights `reputation`'s own already-gated
  factors into `RISK_FACTOR_WEIGHTS`, calibrated so no single reputation
  factor alone reaches the `CRITICAL` threshold (Stage 10 spec section 10:
  "CRITICAL should require strong evidence" — reaching it from reputation
  alone requires multiple corroborating factors). Omitting `reputation`
  behaves exactly as every pre-Stage-10 caller already expects.
- **`health`** (extended) — `MailboxAssessmentService.performRefresh` now
  also calls `reputation`'s `assessReputation` and threads the result into
  `evaluateRisk`. `application/assessment-invalidation-store.ts` (Redis-
  backed, `infrastructure/redis-assessment-invalidation-store.ts`) is the
  lightweight "reassessment-needed marker" Stage 10 spec section 17 asks
  for: `delivery-events` marks a mailbox stale after a genuinely new event
  (never a duplicate), and `getAssessment` checks that flag alongside the
  existing time-based freshness window — either being stale triggers a
  recompute, so a new delivery event can force fresh evidence into the
  very next warmup decision without waiting out the rest of the freshness
  window, and without a synchronous full reassessment on every single
  ingested event. `delivery-events` depends on the narrow
  `AssessmentInvalidationStore` port directly (not the full
  `MailboxAssessmentService`), which is what keeps `delivery-events →
  health → reputation → delivery-events` from being an actual module
  dependency cycle in the code (see `health/README.md`).
- **Audit**: `DELIVERY_EVENT_RECEIVED`, `DELIVERY_EVENT_DUPLICATE`,
  `REPUTATION_ASSESSMENT_CREATED` (every run), `REPUTATION_DEGRADED` /
  `REPUTATION_RECOVERED` (only on the actual status-tier transition, never
  re-fired on every run) — ids/enums/safe numeric summaries only, same
  fail-open recording every other audit event already uses.
- **Deliberately not built these stages**: real provider webhook
  authentication (documented fallback above); a hard/soft bounce split
  (`hardBounceRate` is always `"UNKNOWN"` — the event taxonomy has no such
  distinction to report honestly); a second "adaptive capacity" policy
  separate from `ramp-policy.ts`; changes to `policy/application/capacity-policy.ts`
  (still a pure function of eligibility alone — see `policy/README.md`).

**Provider/domain reputation (Stage 11)**: `reputation` gained
`ProviderReputationSnapshot`/`DomainReputationSnapshot`, computed by the
exact same `evaluateReputation` function used for mailbox-level reputation
(`{ codePrefix: "PROVIDER_" | "DOMAIN_" }`) — never a second reputation or
risk engine. Both aggregate delivery-event evidence across every mailbox a
tenant sends through a given provider or sending domain (never across
tenants), and are embedded in the same `reputation_assessments` row as the
mailbox-level view (`migrations/020_add_provider_domain_reputation.sql`,
additive) rather than new tables. `risk` reads both via their own
`PROVIDER_`/`DOMAIN_`-prefixed factor-code allowlists and roughly
half-weighted `RISK_FACTOR_WEIGHTS` entries — real context, but one step
removed from "this specific mailbox is unsafe," so a mailbox with a clean
own history can see elevated but never CRITICAL-alone risk from a
struggling provider/domain. Domain auth facts (MX/SPF/DKIM/DMARC) are reused
directly from `domain-intelligence` (never re-checked) for visibility only;
they already reach `risk` independently via `health.domain`. New audit
events: `PROVIDER_REPUTATION_DEGRADED`/`_RECOVERED`,
`DOMAIN_REPUTATION_DEGRADED`/`_RECOVERED`. Invalidation is unchanged — a
delivery event still only marks its own mailbox stale, deliberately not
fanning out to other mailboxes sharing the same provider/domain (Stage 11
spec: "avoid excessive recalculation"). Not built this stage: real provider
webhook authentication; a hard/soft bounce split; a per-provider/per-domain
"last known status" store (provider/domain transition audits are detected
per-mailbox, against that mailbox's own previous assessment — a documented,
deliberate limitation, see `reputation/README.md`).

## Database

PostgreSQL, hand-written SQL migrations run via a small migration runner (no
ORM, no SQLite). Every tenant-scoped table carries `tenant_id` with a foreign
key and index; all queries touching tenant data enforce tenant isolation at
the repository layer. Implemented (migrations 001–030): `tenants`,
`mailboxes` (migration 021 adds `timezone`), `provider_accounts`,
`api_credentials`, `audit_events`, `provider_credentials`,
`connection_attempts`, `domain_intelligence`, `mailbox_signals`,
`mailbox_assessments`, `warmup_profiles` (migration 021 adds
`window_start_minute`/`window_end_minute`), `warmup_sessions`,
`warmup_decisions`, `warmup_execution_intents` (migration 016 widened its
`status` CHECK constraint to add `SEND_UNKNOWN`, migration 017 widened it
again to add `REQUIRES_RECONCILIATION` — see the idempotency and
reconciliation sections above — without editing migrations 001-016),
`delivery_events` (migration 018 — append-only, `dedupe_key` the sole
idempotency guard, indexed on `(mailbox_id, observed_at DESC)` for the
rolling-window aggregation query), `reputation_assessments` (migration
019 — append-only history, indexed the same way; migration 020 adds
`provider_reputation`/`domain_reputation` JSONB columns to this same table
rather than creating two new ones — additive only, 001-019 untouched).
Migration 021 (Stage 12) also adds two new partial indexes —
`warmup_sessions_active_due_idx` (the due-session scan) and
`warmup_execution_intents_leased_idx` (the lease-reclaim sweep) — both
justified by genuinely new query patterns this stage introduces, mirroring
the existing `warmup_execution_intents_claimable_idx`'s reasoning. Migration
022 (Stage 13A) adds `mailbox_inbound_sync_state`, `conversations`, and
`conversation_messages` — a facts layer only. Migration 023 (Stage 13B)
adds `conversation_message_classifications` and
`conversation_classification_facts` — classified GTM facts, not actions.
Migration 024 adds classification quality columns and `conversation_domain_facts`.
Migration 025 (Stage 14) adds
`conversation_policy_evaluations` and `conversation_policy_signals` —
policy **signals** only, not execution. Migration 026 (Stage 15) adds
`integration_events_outbox` — durable integration events for pull consumers,
not a generic bus, CRM store, or publisher. Stage 16 does not
add a migration: consumption uses the existing outbox (`event_id` is
external identity; table `id` is internal). Migration 027 (Stage 17) adds
envelope correlation columns (`source`, `mailbox_id`, `execution_intent_id`)
without rewriting `payload`. Migration 028 rejects UPDATE/DELETE on
the outbox so historical events cannot be silently rewritten.
Migration 029 (Stage 20) adds global `warmup_networks` /
`warmup_network_pools` / `warmup_network_domains` /
`warmup_network_mailboxes` / `warmup_network_routing_decisions` — partner
**recipient** routing, no `tenant_id` on pool/domain/mailbox rows.
Migration 030 (Stage 20 identity) adds tenant-scoped `warmup_pools` /
`warmup_pool_memberships` — optional **sender** WHO selector. Do not merge
029 and 030.

CRM, sequences, suppression storage, and `warmup_metrics` are **out of
scope for this service** (main platform). Do not treat them as later stages
of this repository.

## Workers

Separate process entrypoints under `src/workers/`, independently
restartable/scalable from the API process — not BullMQ queue consumers
(see the Core architecture correction above and `scheduling/README.md`).
`execution-worker-process.ts` (Stage 12) is the warmup worker. Stage 13A
adds `inbound-poller-process.ts`: a second long-running poll loop for
conversation facts (inbound fetch + outbound materialization). It does not
send mail and does not share the warmup intent claim path. Concurrency
uses `mailbox_inbound_sync_state` `FOR UPDATE SKIP LOCKED`. Stage 13B adds
`conversation-classification-process.ts`, a third poll loop that classifies
already-persisted messages. It does not share inbound mailbox leases or
warmup intent claims. Stage 14 adds `conversation-policy-process.ts`, a
fourth poll loop that evaluates persisted domain facts into policy signals.
It does not share classification leases or warmup intent claims.

Stage 15 does not add a publisher worker. Integration events are written
transactionally with policy signals and read through authenticated HTTP.
Stage 16 hardens that pull: tenant-isolated keyset pagination, stable
`event_id` identity, explicit `schema_version`, at-least-once delivery
(consumers dedupe; no exactly-once claim), no ACK/lease/queue on the
outbox. The pipeline stops at integration events — CRM, sequences, and
suppression storage belong to the main platform. Stage 17 hardens the
pull contract (`docs/INTEGRATION_CONTRACT.md`) and still does not publish.
Stage 18 documents production handoff and database-immutability of the
outbox. Stage 19 freezes the release for external engineer handoff
(`docs/SOFTWARE_ENGINEER_HANDOFF.md`); no new product surface. Process-local
counters live in `src/shared/observability/metrics.ts`. This repository does
**not** ship an OpenTelemetry exporter (operational enhancement).

## Providers

`ProviderAdapter` port defined once in `modules/providers/domain`; adapters
for Gmail/Google Workspace, Microsoft 365, and generic SMTP/IMAP implement it
under `modules/providers/infrastructure/*`. Business logic (mailbox, warmup,
conversations) depends only on the interface — provider selection is a small
factory (`ProviderRegistry`) in `providers/application`, never a type-switch
scattered across callers. Each adapter's README documents the external
configuration it needs; an unconfigured adapter fails closed rather than
faking success. `sendMessage` is real on Gmail/Microsoft 365 (Stage 9) and
absent on SMTP/IMAP — optional on the interface, the same pattern `oauth`
already used, so a provider without a safe implementation is never forced
to fake one.

**Live-send certification** (hardening pass): the only place this codebase
is permitted to send a real email outside a test's mocked `fetch` is
`src/cli/certify-provider-send.ts`, a standalone, manually-run script gated
behind an explicit `ALLOW_LIVE_PROVIDER_CERTIFICATION=true` opt-in and
operator-supplied tenant/mailbox/recipient — never wired into
`composition/build-services.ts`, never reachable from an HTTP route or the
execution worker, never run by any test suite or CI job. See
`docs/PROVIDER_CERTIFICATION_RUNBOOK.md`.

## Security

Mailbox credentials are never stored in plaintext. `shared/crypto` holds
`EncryptionService` (env-key AES today; a KMS implementation is not in this
release). Tenant identity is derived only from authenticated request
context (`auth` module, from a hashed API key) — never trusted from a
request body/param. Secrets are never logged (pino path redaction plus
`sanitizeForLogging`). Required environment variables are validated at
startup via a typed config module (Stage 2). See
`docs/ENVIRONMENT_REFERENCE.md`.

## API

Versioned under `/api/v1`. Route modules live in each domain module's `api/`
folder and are registered from `src/app.ts`. Request/response
validated with zod schemas. Typed
domain errors map to consistent HTTP error responses; internal stack traces
are never exposed to callers.

## Stage plan

1. Architecture and repository structure — **complete**
2. Configuration, logging, errors, core types
3. PostgreSQL schema and migrations
4. Tenant and API authentication foundation
5. Mailbox domain and provider abstraction
6. Mailbox onboarding/state machine
7. Warmup profile and mailbox intelligence pipeline (health/risk/policy/domain-intelligence)
8. Warmup engine foundation — state machine, decision engine, execution intents, worker (execution used a non-sending fallback provider)
9. Real provider send boundary (Gmail/Microsoft 365 sendMessage, SEND_UNKNOWN handling), Warmup Profile management API, and (hardening pass) unknown-send reconciliation foundation + provider send certification path
10. Delivery events, mailbox-level reputation intelligence, and the adaptive warmup feedback loop; real provider webhook authentication and a hard/soft bounce distinction remain future work
11. Provider-level and domain-level reputation, aggregated across every mailbox on that provider/domain per tenant, feeding the same `risk`/`ramp-policy.ts` boundary; real provider webhook authentication and the hard/soft bounce distinction remain future work
12. Durable warmup scheduling — Postgres-native scheduler + long-running worker process, lease-expiry reclaim with heartbeat renewal, mailbox timezone, and configurable send windows/quiet hours. Stage 12.1: bounded, classified OAuth credential-refresh timeout (`PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`) — **frozen**
13. Conversation facts layer (13A): persist/normalize EMAIL conversations and messages via polling + outbound materialization — **complete**. Mailbox-to-mailbox partner selection remains out of scope here.
14. Conversation policy signal layer — **complete**
15. Integration-event outbox + authenticated pull — **complete** (REST grew across earlier stages; this service does not publish OpenAPI as a separate artifact)
16. Consumption contract hardening (tenant-isolated keyset, `eventId`, at-least-once) — **complete**
17. Integration pull contract (`docs/INTEGRATION_CONTRACT.md`) — **complete**
18. Production handoff + outbox immutability — **complete**
19. Final release freeze and software-engineer handoff — **complete** (documentation/process contract; no new product functionality)
20. Skout-managed warmup network (infrastructure tables, eligibility, deterministic routing, opt-in send recipient). Default remains self-send. **Not** a live production partner fleet — see `docs/WARMUP_NETWORK.md`.
20b. Tenant sending-identity pools (optional WHO selector for the tenant’s own mailboxes). Sessions remain per-mailbox; partner network is a separate layer — see `docs/WARMUP_POOL_ROTATION.md`.
21. Warmup-network productionization: request-key advisory lock, capacity reservation guard, failure-class honesty (capacity/cooldown temporary), routing exceptions → `TEMPORARY_FAILURE` (never SENT), customer AUTH_FAILED does not poison partner credentials, process metrics, GET-only APIs, ops docs. Default routing remains **off**. Tables still ≠ a live fleet.
22. Final enterprise release-candidate / pre-handoff audit (documentation consistency, migration 001–030, validation). No new product surface.
23. Enterprise release and engineering handoff gate — **complete** as a process/docs gate (no new product surface). Frozen send/safety/ramp/risk/reputation/inbound/classification/policy/outbox semantics. Default `WARMUP_NETWORK_ROUTING_MODE=off`. Warmup-network (029) and warmup-pool (030) remain separate layers.

Each stage is verified (typecheck, tests, build) before the next begins.

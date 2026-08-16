# Skout Email Warmup Service — Architecture

Standalone microservice. Does not import, copy, or depend on code from any
other Skout repository. Independently deployable and operable; may later
integrate with Skout Email Intelligence, Skout outbound/campaign systems, the
Skout main application, n8n, or external applications — none of those are
dependencies of this service.

## Product philosophy

`OBSERVE → ANALYZE → SCORE → PREDICT → DECIDE → ACT → OBSERVE AGAIN`

Warmup volume is never a fixed global schedule. It is the output of a policy
decision computed from observed health, risk, and provider signals. See
`src/modules/policy/README.md` and `src/modules/warmup/README.md`.

## Core architecture

TypeScript (strict) + Node.js + Fastify + PostgreSQL + Redis + BullMQ + Docker.
Clean-architecture module boundaries without unnecessary abstraction: each
domain module is split into `domain/` (types, pure logic), `application/`
(services/use-cases), `infrastructure/` (repositories, adapters), `api/`
(Fastify routes). Dependencies flow `api → application → domain`, with
`infrastructure` implementing interfaces defined in `domain`/`application`
(ports-and-adapters). `shared/` holds domain-agnostic building blocks (config,
logger, errors, db, redis, queue, http, observability) and never imports from
`modules/*`.

## Directory structure

```
src/
  app.ts                     buildApp(): FastifyInstance — testable, no listen()
  server.ts                  process bootstrap: buildApp() + listen()
  modules/
    tenancy/                 Tenant aggregate, tenant lookup
    auth/                    API keys, request → TenantId resolution
    mailbox/                 Mailbox aggregate + onboarding state machine
    providers/                MailboxProvider interface + gmail/microsoft365/smtp-imap adapters;
                              Gmail/Microsoft 365 also implement real sendMessage (Stage 9)
    domain-intelligence/     SPF/DKIM/DMARC/MX/DNS signal evaluation (Redis → Postgres → DNS)
    warmup/                  WarmupProfile (+ management API) + warmup state machine,
                              ramp/decision engine, execution intents, claim-based worker, and
                              the real provider send boundary — see warmup/README.md, in
                              particular its SEND_UNKNOWN/idempotency limitation
    conversations/           Controlled mailbox-to-mailbox interactions
    scheduling/               BullMQ job creation, retry/backoff, distributed locks (not yet implemented)
    delivery-events/         Normalized delivery-event ingestion + idempotent persistence +
                              rolling-window aggregation (Stage 10)
    health/                  Mailbox health assessment (6 dimensions) + the cross-module
                              orchestrator that assembles one AssessmentSnapshot per refresh
                              (Stage 10: also computes reputation, checks staleness invalidation)
    risk/                    Risk engine — weighted score + level, computed from health output
                              (Stage 10: + optional reputation-derived factors)
    reputation/              Mailbox-level, delivery-evidence reputation assessment (Stage 10);
                              provider/domain-level signals remain future work — see reputation/README.md
    policy/                  Warmup eligibility decision + capacity recommendation, computed
                              from health + risk output
    audit/                   Append-only audit event log
  shared/
    config/  logger/  errors/  types/  db/  redis/  queue/  http/  observability/
  plugins/                   Fastify plugin wiring (auth, error handling, OpenAPI)
  workers/                   Standalone worker process entrypoints
migrations/                  SQL migrations (hand-written, no ORM)
tests/
  unit/
  integration/
docs/
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
foundation described below; `scheduling` remains unimplemented (job/queue
foundation for a future stage). None of these modules call back "up" the
chain or into each other's infrastructure — see each module's own README
for its exact dependency direction.

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

### Adaptive warmup feedback loop (Stage 10)

```
Provider Send → Delivery Event → Normalized Event → Mailbox Reputation
  → Risk factor → (existing) Risk Assessment → (existing) Ramp Policy
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
- **Deliberately not built this stage**: real provider webhook
  authentication (documented fallback above); a hard/soft bounce split
  (`hardBounceRate` is always `"UNKNOWN"` — the event taxonomy has no such
  distinction to report honestly); a second "adaptive capacity" policy
  separate from `ramp-policy.ts`; changes to `policy/application/capacity-policy.ts`
  (still a pure function of eligibility alone — see `policy/README.md`);
  `provider_signals`/provider-level reputation (still real future work,
  now layered onto the same `reputation` module rather than a separate one).

## Database

PostgreSQL, hand-written SQL migrations run via a small migration runner (no
ORM, no SQLite). Every tenant-scoped table carries `tenant_id` with a foreign
key and index; all queries touching tenant data enforce tenant isolation at
the repository layer. Implemented so far (migrations 001-019): `tenants`,
`mailboxes`, `provider_accounts`, `api_credentials`, `audit_events`,
`provider_credentials`, `connection_attempts`, `domain_intelligence`,
`mailbox_signals`, `mailbox_assessments`, `warmup_profiles`,
`warmup_sessions`, `warmup_decisions`, `warmup_execution_intents` (migration
016 widened its `status` CHECK constraint to add `SEND_UNKNOWN`, migration
017 widened it again to add `REQUIRES_RECONCILIATION` — see the idempotency
and reconciliation sections above — without editing migrations 001-016),
`delivery_events` (migration 018 — append-only, `dedupe_key` the sole
idempotency guard, indexed on `(mailbox_id, observed_at DESC)` for the
rolling-window aggregation query), `reputation_assessments` (migration
019 — append-only history, indexed the same way). Still planned for later
stages: `conversations`, `conversation_messages`, `warmup_metrics`,
`provider_signals`.

## Workers

Separate process entrypoints under `src/workers/`, one per BullMQ queue owned
by `scheduling`. Job handlers are idempotent, retryable with backoff, carry
tenant/mailbox/correlation ids, and use Redis-based distributed locking so
multiple worker instances can run the same queue safely without duplicate
execution.

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

Mailbox credentials are never stored in plaintext. `shared/` will hold a
`CredentialCipher` abstraction (env-key implementation now, swappable for a
production KMS later). Tenant identity is derived only from authenticated
request context (`auth` module, from a hashed API key) — never trusted from a
request body/param. Secrets are never logged. Required environment variables
are validated at startup via a typed config module (Stage 2).

## API

Versioned under `/api/v1`. Route modules live in each domain module's `api/`
folder and are registered centrally via `src/plugins/`. Request/response
validated with zod schemas, which also feed OpenAPI documentation. Typed
domain errors map to consistent HTTP error responses; internal stack traces
are never exposed to callers.

## Stage plan

1. Architecture and repository structure — **this stage**
2. Configuration, logging, errors, core types
3. PostgreSQL schema and migrations
4. Tenant and API authentication foundation
5. Mailbox domain and provider abstraction
6. Mailbox onboarding/state machine
7. Warmup profile and mailbox intelligence pipeline (health/risk/policy/domain-intelligence)
8. Warmup engine foundation — state machine, decision engine, execution intents, worker (execution used a non-sending fallback provider)
9. Real provider send boundary (Gmail/Microsoft 365 sendMessage, SEND_UNKNOWN handling), Warmup Profile management API, and (hardening pass) unknown-send reconciliation foundation + provider send certification path
10. Delivery events, mailbox-level reputation intelligence, and the adaptive warmup feedback loop — **this stage**; real provider webhook authentication, hard/soft bounce distinction, and provider/domain-level reputation signals remain future work
11. Conversation engine, mailbox-to-mailbox partner selection
12. Policy/readiness engine refinements
13. REST API/OpenAPI
14. Security hardening
15. Observability
16. Integration tests
17. Docker/production hardening

Each stage is verified (typecheck, tests, build) before the next begins.

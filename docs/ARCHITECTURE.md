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
    providers/                MailboxProvider interface + gmail/microsoft365/smtp-imap adapters
    domain-intelligence/     SPF/DKIM/DMARC/MX/DNS signal evaluation (Redis → Postgres → DNS)
    warmup/                  WarmupProfile + warmup state machine, ramp/decision engine,
                              execution intents, claim-based worker (no real send yet — see
                              warmup/README.md)
    conversations/           Controlled mailbox-to-mailbox interactions
    scheduling/               BullMQ job creation, retry/backoff, distributed locks (not yet implemented)
    delivery-events/         Delivery event ingestion/normalization
    health/                  Mailbox health assessment (6 dimensions) + the cross-module
                              orchestrator that assembles one AssessmentSnapshot per refresh
    risk/                    Risk engine — weighted score + level, computed from health output
    reputation/              Provider/domain-level reputation signals
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
  depends on; it never imports a concrete provider adapter directly.
  `infrastructure/unimplemented-warmup-send-provider.ts` is the only
  implementation registered in composition this stage — every call
  reports an honest, non-retryable failure rather than fabricating
  success or attempting a real send (see warmup/README.md). This exercises
  the full claim → lease → safety-gate → port → record pipeline without
  ever attempting a real network send. A real provider-backed
  implementation is later work.

## Database

PostgreSQL, hand-written SQL migrations run via a small migration runner (no
ORM, no SQLite). Every tenant-scoped table carries `tenant_id` with a foreign
key and index; all queries touching tenant data enforce tenant isolation at
the repository layer. Implemented so far (migrations 001-015): `tenants`,
`mailboxes`, `provider_accounts`, `api_credentials`, `audit_events`,
`provider_credentials`, `connection_attempts`, `domain_intelligence`,
`mailbox_signals`, `mailbox_assessments`, `warmup_profiles`,
`warmup_sessions`, `warmup_decisions`, `warmup_execution_intents`. Still
planned for later stages: `conversations`, `conversation_messages`,
`delivery_events`, `warmup_metrics`.

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
faking success.

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
8. Warmup engine foundation — state machine, decision engine, execution intents, worker (execution uses a non-sending fallback provider) — **this stage**
9. Conversation engine
10. Delivery/event processing
11. Health/risk/intelligence engines
12. Policy/readiness engine
13. REST API/OpenAPI
14. Security hardening
15. Observability
16. Integration tests
17. Docker/production hardening

Each stage is verified (typecheck, tests, build) before the next begins.

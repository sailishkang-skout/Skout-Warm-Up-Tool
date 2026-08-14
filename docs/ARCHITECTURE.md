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
    domain-intelligence/     SPF/DKIM/DMARC/DNS signal evaluation
    warmup/                  Warmup profile, ramp policy, recommended volume
    conversations/           Controlled mailbox-to-mailbox interactions
    scheduling/               BullMQ job creation, retry/backoff, distributed locks
    delivery-events/         Delivery event ingestion/normalization
    health/                  Multi-dimensional mailbox health engine
    risk/                    Risk engine (current value + trend/velocity)
    reputation/              Provider/domain-level reputation signals
    policy/                  Central decision engine (INCREASE/MAINTAIN/REDUCE/PAUSE/...)
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

## Database

PostgreSQL, hand-written SQL migrations run via a small migration runner (no
ORM, no SQLite). Every tenant-scoped table carries `tenant_id` with a foreign
key and index; all queries touching tenant data enforce tenant isolation at
the repository layer. Planned tables (Stage 3): `tenants`, `api_keys`,
`mailboxes`, `mailbox_credentials`, `mailbox_provider_accounts`,
`warmup_profiles`, `warmup_schedules`, `warmup_jobs`, `warmup_messages`,
`conversations`, `conversation_messages`, `delivery_events`,
`mailbox_health_snapshots`, `mailbox_risk_events`, `provider_signals`,
`warmup_metrics`, `policy_decisions`, `audit_events`.

## Workers

Separate process entrypoints under `src/workers/`, one per BullMQ queue owned
by `scheduling`. Job handlers are idempotent, retryable with backoff, carry
tenant/mailbox/correlation ids, and use Redis-based distributed locking so
multiple worker instances can run the same queue safely without duplicate
execution.

## Providers

`MailboxProvider` port defined once in `modules/providers/domain`; adapters
for Gmail/Google Workspace, Microsoft 365, and generic SMTP/IMAP implement it
under `modules/providers/infrastructure/*`. Business logic (mailbox, warmup,
conversations) depends only on the interface — provider selection is a small
factory in `providers/application`, never a type-switch scattered across
callers. Each adapter's README documents the external configuration it needs;
an unconfigured adapter fails closed rather than faking success.

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
7. Warmup profile and scheduling foundation
8. Warmup worker engine
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

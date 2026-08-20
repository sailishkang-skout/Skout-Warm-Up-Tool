# Shared

Low-level, domain-agnostic building blocks used across modules: `config`
(typed, validated env), `logger` (structured logging, correlation ids),
`errors` (typed domain error base classes), `types` (small cross-cutting types
like `TenantId`, `RequestContext`), `db` (Postgres pool + migration runner),
`redis` (client), `queue/` (empty directory — `bullmq` is unused; workers
use Postgres leases), `http` (Fastify error-mapping, common plugins wiring),
`observability` (process-local counters in `metrics.ts`, correlation ids).
There is no OpenTelemetry exporter in this repository.

**Rule**: `shared/` never imports from `modules/*`. Dependencies only flow
inward — modules depend on shared, never the reverse — which is what keeps this
directory free of circular dependencies as the service grows.

**Target stage**: Stage 2 (config, logging, errors, core types) through
Stage 19 (release freeze / engineer handoff). Observability is structured
logs, audit, and in-process counters — not an OTEL pipeline.

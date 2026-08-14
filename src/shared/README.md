# Shared

Low-level, domain-agnostic building blocks used across modules: `config`
(typed, validated env), `logger` (structured logging, correlation ids),
`errors` (typed domain error base classes), `types` (small cross-cutting types
like `TenantId`, `RequestContext`), `db` (Postgres pool + migration runner),
`redis` (client), `queue` (BullMQ helpers shared by `scheduling`), `http`
(Fastify error-mapping, common plugins wiring), `observability` (metrics,
correlation id propagation, OpenTelemetry-ready hooks).

**Rule**: `shared/` never imports from `modules/*`. Dependencies only flow
inward — modules depend on shared, never the reverse — which is what keeps this
directory free of circular dependencies as the service grows.

**Target stage**: Stage 2 (config, logging, errors, core types) through Stage 15
(observability), filled in incrementally per stage.

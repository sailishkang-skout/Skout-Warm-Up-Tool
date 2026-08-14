# Plugins

Fastify plugins that wire cross-cutting HTTP concerns into the app instance
(helmet, cors, auth decoration, error handler, request-id/correlation-id
propagation, OpenAPI/schema registration). Route registration for each domain
module's `api/` folder is composed here, not inline in `app.ts`.

**Target stage**: grows alongside Stage 4 (auth), Stage 13 (REST API/OpenAPI),
Stage 15 (observability).

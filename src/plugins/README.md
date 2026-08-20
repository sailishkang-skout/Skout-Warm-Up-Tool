# Plugins

Fastify plugins that wire cross-cutting HTTP concerns into the app instance
(helmet, cors, auth decoration, error handler, request-id/correlation-id
propagation). Domain `api/` route modules are registered from `src/app.ts`.

**Target stage**: Stage 4 (auth) onward. Stage 19 freeze: no new plugin
surface; OpenAPI remains schema-on-routes rather than a published artifact.

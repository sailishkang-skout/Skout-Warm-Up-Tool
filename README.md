# Skout Email Warmup Service

Standalone mailbox warmup and conversation-intelligence microservice.
It does not import other Skout repositories.

**Start here for platform integration:**
[`docs/SOFTWARE_ENGINEER_HANDOFF.md`](docs/SOFTWARE_ENGINEER_HANDOFF.md)

Also:

- [`docs/INTEGRATION_CONTRACT.md`](docs/INTEGRATION_CONTRACT.md) — pull API
- [`docs/PRODUCTION_HANDOFF.md`](docs/PRODUCTION_HANDOFF.md) — operations
- [`docs/ENVIRONMENT_REFERENCE.md`](docs/ENVIRONMENT_REFERENCE.md) — env vars
- [`docs/DISASTER_RECOVERY.md`](docs/DISASTER_RECOVERY.md) — backup/restore assumptions
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — PII and retention
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals

Pipeline: mailbox → warmup → optional warmup-network (recipient; default
off) → provider send → inbound → conversations → classification → policy →
integration events (pull). Tenant warmup-pool (030) is a separate optional
sender selector and is not wired to the scheduler. CRM, sequences,
suppression, and LinkedIn are **not** implemented here.

Local infra: `npm run db:up` (Postgres **5433**, Redis **6380**), then
`npm run migrate:up`. Run the API plus four workers; see the handoff.

## Container / Skout platform

- `Dockerfile` builds a multi-process image (API + workers via different CMD).
- Skout Backend proxies at `/api/v1/warmup-tool/*` and provisions a tenant per
  workspace via `POST /api/v1/internal/provision-tenant` (`PLATFORM_PROVISIONING_KEY`).
- Testing guide lives in the Backend repo: `docs/WARMUP_TOOL_TESTING.md`.

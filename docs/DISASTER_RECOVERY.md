# Disaster recovery

This document describes what this **repository** can actually support.
It does **not** claim an RPO/RTO: those depend on the operator’s Postgres
and Redis hosting (snapshots, HA, region). Do not treat this file as a
measured SLA.

## PostgreSQL (system of record)

All durable state lives here: tenants, mailboxes, credentials (encrypted),
warmup, conversations, classifications, policy signals, `integration_events_outbox`.

**Backup expectations (operator):** periodic logical or physical backups of
the production database pointed to by `DATABASE_URL`. Test restores on a
non-production instance. This service does not bundle backup jobs.

**Restore procedure (operator):**

1. Stop API and all four workers.
2. Restore Postgres to a consistent backup.
3. `npm run migrate:validate` then `npm run migrate:up` if the backup is
   from an older schema (forward-only; never edit applied files 001–030).
4. Start API, confirm `GET /readiness`.
5. Start workers.

After restore, integration consumers must **replay from a checkpoint at or
before** the restored outbox: at-least-once + `eventId` dedupe makes this safe.
Do not assume the consumer’s checkpoint is still valid if it pointed at
events not present in the restored backup.

## Redis

Used for OAuth pending state, mailbox connection locks, DNS cache, assessment
invalidation. **Not** the integration-event store and **not** worker leases.

If Redis is wiped: OAuth in-flight connects fail and must be retried; connection
locks release; DNS/assessment caches refill. Postgres leases and outbox are
unaffected. Workers still require Redis **connectivity** at process start.

## Integration events

Durable in Postgres. Migration 028 rejects UPDATE/DELETE. Consumer cursor is
stored **by the platform**, not here. Recovery: resume `GET /api/v1/integration-events`
from last saved `eventId` (or from the start and skip applied IDs).

## Worker leases

Postgres `lease_expires_at` (~60s hardcoded on claim paths). Crash or SIGKILL:
another worker reclaims after expiry. No Redis lock for warmup/classification/policy
ticks.

## Provider cursors

Inbound mailbox sync cursor lives in `mailbox_inbound_sync_state` (Postgres).
Invalid provider history cursors are handled as cursor-invalid (re-bootstrap
per inbound code). Restoring Postgres restores those cursors.

## Retention

This service does not auto-purge conversations, message `text_body`, or
outbox events. Retention and deletion are **operator / main-platform**
responsibilities (tenant offboarding). Do not DELETE outbox rows as a
retention strategy without a new, explicit contract — consumers may still
hold checkpoints.

## Data that is not recovered from Redis

Anything only in Redis (short-lived OAuth state) is lost on Redis failure.
Mailbox OAuth tokens live encrypted in Postgres.

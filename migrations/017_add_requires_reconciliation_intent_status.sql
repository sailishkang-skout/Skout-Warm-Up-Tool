-- Hardening spec Gap A: SEND_UNKNOWN has no operational path out of it
-- today other than direct database inspection. This adds the minimum safe
-- foundation for reconciliation — a distinct, still-terminal
-- REQUIRES_RECONCILIATION status reached only via an explicit,
-- tenant-scoped, idempotent action (see
-- src/modules/warmup/application/warmup-reconciliation-service.ts). It is
-- never entered automatically, never retried, and never reachable by
-- claimNext (PENDING-only) — exactly the same non-retryable shape as
-- SEND_UNKNOWN itself. See
-- src/modules/warmup/domain/warmup-execution-intent.ts and
-- docs/ARCHITECTURE.md's idempotency section.
--
-- Migrations 001-016 are frozen — this only widens the existing CHECK
-- constraint on warmup_execution_intents.status (added in migration 015,
-- already widened once in migration 016) by dropping and recreating it,
-- never editing either file in place. No existing row's status value is
-- affected.

ALTER TABLE warmup_execution_intents
  DROP CONSTRAINT warmup_execution_intents_status_check;

ALTER TABLE warmup_execution_intents
  ADD CONSTRAINT warmup_execution_intents_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED', 'SEND_UNKNOWN', 'REQUIRES_RECONCILIATION'));

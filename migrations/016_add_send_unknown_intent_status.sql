-- Stage 9 spec section 7 requires the engine be able to distinguish "the
-- provider definitely did not accept this send" from "we cannot confirm
-- whether it did" — neither Gmail's API nor Microsoft Graph's `sendMail`
-- expose a client-supplied idempotency token, so a network failure or
-- timeout after the request left this process can genuinely mean either.
-- `SEND_UNKNOWN` is that third, terminal state: never reclaimed by the
-- worker's claim query (which only selects `PENDING`), so it can never be
-- silently retried into a duplicate send. See
-- src/modules/warmup/domain/warmup-execution-intent.ts and
-- docs/ARCHITECTURE.md's idempotency section.
--
-- Migrations 001-015 are frozen — this only widens the existing CHECK
-- constraint on warmup_execution_intents.status (added in migration 015)
-- by dropping and recreating it, never editing that file in place. No
-- existing row's status value is affected.

ALTER TABLE warmup_execution_intents
  DROP CONSTRAINT warmup_execution_intents_status_check;

ALTER TABLE warmup_execution_intents
  ADD CONSTRAINT warmup_execution_intents_status_check
  CHECK (status IN ('PENDING', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED', 'SEND_UNKNOWN'));

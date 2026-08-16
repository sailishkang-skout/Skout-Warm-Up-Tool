-- Stage 5 correction to the mailbox lifecycle: the original status enum
-- (committed in 002_create_mailboxes.sql) conflated three genuinely
-- different concerns into one column — provider connection state, warmup
-- progress, and operational on/off. Splitting them:
--
--   mailboxes.status  -> connection lifecycle only (PENDING/CONNECTING/
--                        CONNECTED/DISCONNECTED/ERROR)
--   mailboxes.enabled -> operational on/off, orthogonal to connection state
--                        (a mailbox can be enabled but disconnected, or
--                        disabled but still connected)
--   warmup progress   -> belongs to a future warmup_profile table (Stage 7+),
--                        not this column
--
-- Both `mailboxes` and `provider_accounts` are empty in every environment
-- this migration will run against so far (dev DB verified empty before
-- writing this), so there is no existing-row data to remap.

ALTER TABLE mailboxes
  DROP CONSTRAINT mailboxes_status_check;

ALTER TABLE mailboxes
  ALTER COLUMN status SET DEFAULT 'PENDING';

ALTER TABLE mailboxes
  ADD CONSTRAINT mailboxes_status_check
  CHECK (status IN ('PENDING', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR'));

ALTER TABLE mailboxes
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN display_name TEXT;

-- provider_accounts already carries its own connection-state column
-- (status: PENDING/ACTIVE/DISCONNECTED/ERROR, from 003) — deliberately kept
-- as-is rather than renamed, distinct from mailboxes.status by table, not by
-- name. What it's missing for Stage 5's connect flow: somewhere safe to
-- record non-secret provider-supplied metadata, and the outcome of the last
-- connection/health check attempt.
ALTER TABLE provider_accounts
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN last_checked_at TIMESTAMPTZ,
  ADD COLUMN last_error TEXT;

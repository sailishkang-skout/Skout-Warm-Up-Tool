-- The record of "this specific send attempt is about to happen" — Stage 8
-- spec section 11. Distinct from warmup_decisions: a decision says what
-- should happen, an intent is the claimable/leasable unit of work a worker
-- acts on. Creating a row here is never itself a send (see
-- src/modules/warmup/application/warmup-send-provider.ts).
--
-- `idempotency_key` is the actual uniqueness guard (Stage 8 spec section
-- 12) — deterministic from tenant/session/warmup_day/execution_slot (see
-- warmup-execution-intent.ts's computeIdempotencyKey), so a duplicate
-- request can never create a duplicate intent. `lease_owner`/
-- `lease_expires_at`/`attempt_count` back the claim model (section 13):
-- claiming is a single atomic UPDATE ... WHERE status = 'PENDING' ...
-- FOR UPDATE SKIP LOCKED (see the repository), never a
-- read-then-write pair.

CREATE TABLE warmup_execution_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  session_id UUID NOT NULL REFERENCES warmup_sessions (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  decision_id UUID NOT NULL REFERENCES warmup_decisions (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  warmup_day INTEGER NOT NULL CHECK (warmup_day >= 1),
  execution_slot INTEGER NOT NULL CHECK (execution_slot >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  volume INTEGER NOT NULL CHECK (volume > 0),
  scheduled_for TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'EXPIRED')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_result JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_execution_intents_session_day_slot_unique UNIQUE (session_id, warmup_day, execution_slot)
);

CREATE INDEX warmup_execution_intents_tenant_id_idx ON warmup_execution_intents (tenant_id);
CREATE INDEX warmup_execution_intents_session_id_idx ON warmup_execution_intents (session_id, warmup_day, execution_slot);

-- The claim path's working set: only PENDING rows are ever candidates, so a
-- partial index keeps it small regardless of how much SENT/FAILED history
-- accumulates.
CREATE INDEX warmup_execution_intents_claimable_idx
  ON warmup_execution_intents (created_at)
  WHERE status = 'PENDING';

CREATE TRIGGER trg_warmup_execution_intents_set_updated_at
  BEFORE UPDATE ON warmup_execution_intents
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

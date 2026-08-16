-- The warmup lifecycle aggregate — Stage 8 spec sections 3-5. `state`
-- follows the exact transition graph in
-- src/modules/warmup/domain/warmup-state.ts; this table never allows an
-- arbitrary state, only what that graph permits (enforced in application
-- code via a CAS update, not a DB trigger, since the transition rules
-- themselves are richer than a CHECK constraint can express).
--
-- `current_day`/`current_daily_target`/`committed_volume_today`/
-- `next_execution_slot` are the per-warmup-day counters the ramp and
-- idempotency model depend on (see warmup-day.ts and
-- warmup-execution-intent.ts) — reset atomically together whenever the day
-- advances (postgres-warmup-session-repository.ts's `recordDailyDecision`).
--
-- The partial unique index below is the actual source of truth for "one
-- open session per mailbox" (Stage 8 spec section 5) — the application
-- layer checks this too, but only the database constraint is race-proof.

CREATE TABLE warmup_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  profile_id UUID NOT NULL REFERENCES warmup_profiles (id),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'ACTIVE', 'PAUSED', 'COOLDOWN', 'COMPLETED', 'STOPPED', 'FAILED')),
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  current_day INTEGER NOT NULL DEFAULT 0 CHECK (current_day >= 0),
  current_daily_target INTEGER NOT NULL DEFAULT 0 CHECK (current_daily_target >= 0),
  committed_volume_today INTEGER NOT NULL DEFAULT 0 CHECK (committed_volume_today >= 0),
  next_execution_slot INTEGER NOT NULL DEFAULT 0 CHECK (next_execution_slot >= 0),
  last_decision_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_sessions_committed_within_target CHECK (committed_volume_today <= current_daily_target)
);

CREATE INDEX warmup_sessions_tenant_id_idx ON warmup_sessions (tenant_id);
CREATE INDEX warmup_sessions_mailbox_id_idx ON warmup_sessions (mailbox_id);

-- One open (non-terminal) session per mailbox. COMPLETED/STOPPED are the
-- only states excluded — everything else (including FAILED, which can
-- still be recovered into PAUSED) counts as occupying the mailbox's one
-- session slot.
CREATE UNIQUE INDEX warmup_sessions_one_open_per_mailbox
  ON warmup_sessions (mailbox_id)
  WHERE state NOT IN ('COMPLETED', 'STOPPED');

CREATE TRIGGER trg_warmup_sessions_set_updated_at
  BEFORE UPDATE ON warmup_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

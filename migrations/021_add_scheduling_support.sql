-- Stage 12: durable scheduling support. Extends existing tables only — no
-- new `scheduled_actions`/job table (see warmup/README.md's Stage 12
-- section): `warmup_sessions` + `warmup_execution_intents` already are the
-- durable scheduling state; this migration only adds what those tables are
-- genuinely missing to support it.
--
-- `mailboxes.timezone` — IANA identifier (e.g. "America/New_York"), never a
-- raw UTC offset (offsets don't survive DST; IANA zones do). Defaults to
-- 'UTC' so every mailbox created before this migration keeps behaving
-- exactly as it did (UTC-only, no window restriction) — timezone becomes an
-- opt-in refinement, not a breaking change. Validated at the application
-- layer (`Intl.DateTimeFormat` construction — see
-- warmup/domain/mailbox-local-time.ts) rather than a CHECK constraint,
-- since validating the ~400-entry IANA zone list in SQL would mean
-- hand-maintaining a duplicate of data the JS runtime's ICU build already
-- carries authoritatively.
ALTER TABLE mailboxes
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- `warmup_profiles` send-window — both-or-neither, nullable so an
-- unconfigured profile means "no window restriction" (matches pre-Stage-12
-- behavior exactly), not a forced default window nobody asked for. Minutes
-- since local midnight (0-1439), not TIME columns, since the window is
-- evaluated against the mailbox's *local* wall-clock time computed fresh
-- each check (see warmup/application/send-window-policy.ts) — a TIME
-- column would invite comparing it against a UTC timestamptz directly,
-- exactly the kind of manual-offset mistake this design avoids.
-- `window_end_minute <= window_start_minute` is a valid, meaningful
-- overnight window (e.g. 22:00-06:00), not an error, so no ordering CHECK.
ALTER TABLE warmup_profiles
  ADD COLUMN window_start_minute INTEGER CHECK (window_start_minute BETWEEN 0 AND 1439),
  ADD COLUMN window_end_minute INTEGER CHECK (window_end_minute BETWEEN 0 AND 1439),
  ADD CONSTRAINT warmup_profiles_window_both_or_neither
    CHECK ((window_start_minute IS NULL) = (window_end_minute IS NULL));

-- Supports the new due-session scan (application/warmup-scheduler.ts):
-- "ACTIVE sessions whose last decision predates today" — a genuinely new
-- query pattern this stage introduces, not speculative. Partial on `state`
-- keeps the index small regardless of how much COMPLETED/STOPPED history
-- accumulates, mirroring warmup_execution_intents_claimable_idx's existing
-- reasoning.
CREATE INDEX warmup_sessions_active_due_idx
  ON warmup_sessions (last_decision_at)
  WHERE state = 'ACTIVE';

-- Supports the new lease-reclaim sweep (postgres-warmup-execution-intent-repository.ts's
-- reclaimExpiredLeases) — CLAIMED/SENDING is normally a brief transient
-- state, so this index stays small in steady state, same reasoning as the
-- existing PENDING partial index below it.
CREATE INDEX warmup_execution_intents_leased_idx
  ON warmup_execution_intents (lease_expires_at)
  WHERE status IN ('CLAIMED', 'SENDING');

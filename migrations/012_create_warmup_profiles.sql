-- Warmup configuration/intelligence inputs for a mailbox — Stage 7 spec
-- section 12 is explicit that this is data, not a scheduler: no job table,
-- no send history, no cadence engine. `active` defaults false because
-- creating a profile must never itself be the thing that starts sending —
-- that decision belongs to whatever later stage actually implements the
-- warmup engine.

CREATE TABLE warmup_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  target_daily_volume INTEGER NOT NULL CHECK (target_daily_volume >= 0),
  starting_daily_volume INTEGER NOT NULL CHECK (starting_daily_volume >= 0),
  maximum_daily_volume INTEGER NOT NULL CHECK (maximum_daily_volume >= 0),
  ramp_strategy TEXT NOT NULL CHECK (ramp_strategy IN ('CONSERVATIVE', 'STANDARD', 'AGGRESSIVE')),
  risk_tolerance TEXT NOT NULL CHECK (risk_tolerance IN ('LOW', 'MEDIUM', 'HIGH')),
  active BOOLEAN NOT NULL DEFAULT false,
  pause_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_profiles_mailbox_unique UNIQUE (mailbox_id)
);

CREATE INDEX warmup_profiles_tenant_id_idx ON warmup_profiles (tenant_id);

CREATE TRIGGER trg_warmup_profiles_set_updated_at
  BEFORE UPDATE ON warmup_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Tenant-owned sending-identity pools (Stage 20 identity rotation).
-- Distinct from migrations/029_create_warmup_network.sql: that module
-- selects a *recipient* (Skout-managed partner mailbox). These tables
-- select which of a *tenant's own* mailboxes should receive the next
-- warmup allocation. Mailbox remains the source of truth; domain is
-- derived from mailbox email. Never rewrite historical execution intents.

CREATE TABLE warmup_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'DRAINING')),
  strategy TEXT NOT NULL DEFAULT 'HEALTH_FIRST_LEAST_USED'
    CHECK (strategy IN ('ROUND_ROBIN', 'LEAST_USED', 'WEIGHTED', 'HEALTH_FIRST', 'HEALTH_FIRST_LEAST_USED')),
  max_consecutive_same_domain INTEGER NOT NULL DEFAULT 2 CHECK (max_consecutive_same_domain >= 1),
  max_domain_share_percent INTEGER NOT NULL DEFAULT 70 CHECK (max_domain_share_percent BETWEEN 1 AND 100),
  last_selected_mailbox_id UUID REFERENCES mailboxes (id),
  last_selected_domain TEXT,
  consecutive_same_domain INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_same_domain >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_pools_tenant_name_unique UNIQUE (tenant_id, name)
);

CREATE INDEX warmup_pools_tenant_id_idx ON warmup_pools (tenant_id, status);

CREATE TRIGGER trg_warmup_pools_set_updated_at
  BEFORE UPDATE ON warmup_pools
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE warmup_pool_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id UUID NOT NULL REFERENCES warmup_pools (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'ACTIVE', 'COOLDOWN', 'DRAINING', 'DISABLED')),
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1 CHECK (weight >= 1),
  max_daily_warmup_volume INTEGER CHECK (max_daily_warmup_volume IS NULL OR max_daily_warmup_volume >= 0),
  current_daily_warmup_volume INTEGER NOT NULL DEFAULT 0 CHECK (current_daily_warmup_volume >= 0),
  usage_date DATE NOT NULL DEFAULT (timezone('utc', now()))::date,
  last_selected_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_pool_memberships_pool_mailbox_unique UNIQUE (pool_id, mailbox_id)
);

CREATE INDEX warmup_pool_memberships_tenant_id_idx ON warmup_pool_memberships (tenant_id);
CREATE INDEX warmup_pool_memberships_pool_status_idx ON warmup_pool_memberships (pool_id, status);
CREATE INDEX warmup_pool_memberships_mailbox_id_idx ON warmup_pool_memberships (mailbox_id);
CREATE INDEX warmup_pool_memberships_cooldown_idx
  ON warmup_pool_memberships (cooldown_until)
  WHERE cooldown_until IS NOT NULL;
CREATE INDEX warmup_pool_memberships_last_selected_idx ON warmup_pool_memberships (last_selected_at);

CREATE TRIGGER trg_warmup_pool_memberships_set_updated_at
  BEFORE UPDATE ON warmup_pool_memberships
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION enforce_warmup_pool_tenant_isolation()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM warmup_pools p
      JOIN mailboxes m ON m.id = NEW.mailbox_id
     WHERE p.id = NEW.pool_id
       AND p.tenant_id = NEW.tenant_id
       AND m.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'warmup pool membership tenant mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_warmup_pool_memberships_tenant_isolation
  BEFORE INSERT OR UPDATE ON warmup_pool_memberships
  FOR EACH ROW
  EXECUTE FUNCTION enforce_warmup_pool_tenant_isolation();

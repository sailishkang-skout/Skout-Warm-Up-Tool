-- Live mailbox infrastructure: operator privilege, operational mailbox
-- lifecycle (separate from connection status), and scoped quarantines.
-- Additive. Migrations 001-031 are frozen. No secrets in these tables.

ALTER TABLE api_credentials
  ADD COLUMN privilege TEXT NOT NULL DEFAULT 'TENANT'
    CHECK (privilege IN ('TENANT', 'OPERATOR'));

CREATE INDEX api_credentials_privilege_idx ON api_credentials (privilege);

CREATE TABLE mailbox_operational_states (
  mailbox_id UUID PRIMARY KEY REFERENCES mailboxes (id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
    'DISCOVERED',
    'PROVISIONING',
    'PROVISIONED',
    'VERIFYING',
    'READY',
    'WARMING',
    'ACTIVE',
    'DEGRADED',
    'QUARANTINED',
    'SUSPENDED',
    'DELETED'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mailbox_operational_states_tenant_id_idx ON mailbox_operational_states (tenant_id);
CREATE INDEX mailbox_operational_states_status_idx ON mailbox_operational_states (status);

CREATE TRIGGER trg_mailbox_operational_states_set_updated_at
  BEFORE UPDATE ON mailbox_operational_states
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE operational_quarantines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('MAILBOX', 'DOMAIN', 'PROVIDER_ACCOUNT', 'NETWORK')),
  scope_id TEXT NOT NULL CHECK (btrim(scope_id) <> ''),
  tenant_id UUID REFERENCES tenants (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operational_quarantines_scope_unique UNIQUE (scope, scope_id)
);

CREATE INDEX operational_quarantines_status_idx ON operational_quarantines (status);
CREATE INDEX operational_quarantines_tenant_id_idx ON operational_quarantines (tenant_id);

CREATE TRIGGER trg_operational_quarantines_set_updated_at
  BEFORE UPDATE ON operational_quarantines
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE mailbox_provisioning_jobs
  ADD COLUMN provider_mailbox_id TEXT,
  ADD COLUMN provider_customer_id TEXT;

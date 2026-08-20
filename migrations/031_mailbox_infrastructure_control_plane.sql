-- Stage 24: tenant-owned domains, organization-level provider accounts,
-- mailbox roles, network kind/membership, kill switches, provisioning jobs.
-- Additive. Migrations 001-030 are frozen. No secrets in these tables.

CREATE TABLE customer_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  domain_name TEXT NOT NULL CHECK (btrim(domain_name) <> ''),
  status TEXT NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN (
    'DISCOVERED', 'PENDING_VERIFICATION', 'VERIFIED', 'CONFIGURING', 'READY', 'DEGRADED', 'SUSPENDED'
  )),
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN (
    'UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED'
  )),
  provider TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'UNKNOWN')),
  dns_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (dns_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  spf_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (spf_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dkim_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (dkim_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dmarc_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (dmarc_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  mx_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (mx_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_domains_tenant_domain_unique UNIQUE (tenant_id, domain_name)
);

CREATE INDEX customer_domains_tenant_id_idx ON customer_domains (tenant_id);

CREATE TRIGGER trg_customer_domains_set_updated_at
  BEFORE UPDATE ON customer_domains
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_domain_id UUID REFERENCES customer_domains (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365')),
  provider_customer_id TEXT,
  customer_domain TEXT NOT NULL CHECK (btrim(customer_domain) <> ''),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'ERROR', 'SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_provider_accounts_tenant_provider_domain_unique UNIQUE (tenant_id, provider, customer_domain)
);

CREATE INDEX organization_provider_accounts_tenant_id_idx ON organization_provider_accounts (tenant_id);

CREATE TRIGGER trg_organization_provider_accounts_set_updated_at
  BEFORE UPDATE ON organization_provider_accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE mailboxes
  ADD COLUMN customer_domain_id UUID REFERENCES customer_domains (id) ON DELETE RESTRICT,
  ADD COLUMN organization_provider_account_id UUID REFERENCES organization_provider_accounts (id) ON DELETE RESTRICT,
  ADD COLUMN role TEXT NOT NULL DEFAULT 'CUSTOMER_SENDER' CHECK (role IN (
    'CUSTOMER_SENDER', 'INTERNAL_NETWORK', 'NETWORK_RECIPIENT'
  ));

CREATE INDEX mailboxes_customer_domain_id_idx ON mailboxes (customer_domain_id);
CREATE INDEX mailboxes_organization_provider_account_id_idx ON mailboxes (organization_provider_account_id);

ALTER TABLE warmup_networks
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (kind IN ('INTERNAL', 'PARTNER'));

ALTER TABLE warmup_network_mailboxes
  ADD COLUMN membership_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (membership_status IN (
    'INVITED', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'QUARANTINED', 'SUSPENDED', 'REMOVED'
  )),
  ADD COLUMN owner_tenant_id UUID REFERENCES tenants (id) ON DELETE RESTRICT,
  ADD COLUMN consent_granted_at TIMESTAMPTZ,
  ADD COLUMN consent_revoked_at TIMESTAMPTZ;

CREATE INDEX warmup_network_mailboxes_membership_status_idx ON warmup_network_mailboxes (membership_status);
CREATE INDEX warmup_networks_kind_idx ON warmup_networks (kind);

CREATE TABLE operational_kill_switches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'PROVIDER', 'NETWORK', 'TENANT', 'DOMAIN', 'MAILBOX')),
  scope_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operational_kill_switches_scope_unique UNIQUE (scope, scope_id)
);

CREATE TRIGGER trg_operational_kill_switches_set_updated_at
  BEFORE UPDATE ON operational_kill_switches
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE mailbox_provisioning_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_domain_id UUID REFERENCES customer_domains (id) ON DELETE RESTRICT,
  organization_provider_account_id UUID REFERENCES organization_provider_accounts (id) ON DELETE RESTRICT,
  email_address TEXT NOT NULL CHECK (btrim(email_address) <> ''),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED')),
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  last_error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_provisioning_jobs_idempotency_unique UNIQUE (idempotency_key)
);

CREATE INDEX mailbox_provisioning_jobs_tenant_id_idx ON mailbox_provisioning_jobs (tenant_id);
CREATE INDEX mailbox_provisioning_jobs_status_idx ON mailbox_provisioning_jobs (status);

CREATE TRIGGER trg_mailbox_provisioning_jobs_set_updated_at
  BEFORE UPDATE ON mailbox_provisioning_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

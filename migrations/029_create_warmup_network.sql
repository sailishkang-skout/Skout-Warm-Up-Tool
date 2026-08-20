-- Stage 20: Skout-managed warmup network (infrastructure routing only).
-- Additive. Migrations 001-028 are frozen. No OAuth tokens. Network
-- mailboxes reuse existing mailboxes + credential store via mailbox_id.
-- Capacity here is infrastructure capacity, not warmup_sessions volume.

CREATE TABLE warmup_networks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_warmup_networks_set_updated_at
  BEFORE UPDATE ON warmup_networks
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE warmup_network_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id UUID NOT NULL REFERENCES warmup_networks (id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX warmup_network_pools_network_id_idx ON warmup_network_pools (network_id);

CREATE TRIGGER trg_warmup_network_pools_set_updated_at
  BEFORE UPDATE ON warmup_network_pools
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE warmup_network_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network_id UUID NOT NULL REFERENCES warmup_networks (id) ON DELETE RESTRICT,
  pool_id UUID NOT NULL REFERENCES warmup_network_pools (id) ON DELETE RESTRICT,
  domain TEXT NOT NULL CHECK (btrim(domain) <> ''),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEGRADED', 'COOLDOWN', 'QUARANTINED', 'DISABLED')),
  authentication_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (authentication_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  spf_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (spf_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dkim_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (dkim_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dmarc_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (dmarc_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  reputation_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (reputation_status IN ('EXCELLENT', 'HEALTHY', 'DEGRADED', 'POOR', 'CRITICAL', 'UNKNOWN')),
  health_score INTEGER NOT NULL DEFAULT 100 CHECK (health_score >= 0 AND health_score <= 100),
  capacity_status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (capacity_status IN ('AVAILABLE', 'EXHAUSTED')),
  daily_capacity INTEGER NOT NULL DEFAULT 50 CHECK (daily_capacity >= 0),
  usage_date DATE NOT NULL DEFAULT (timezone('utc', now()))::date,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_network_domains_domain_unique UNIQUE (domain)
);

CREATE INDEX warmup_network_domains_network_id_idx ON warmup_network_domains (network_id);
CREATE INDEX warmup_network_domains_pool_id_idx ON warmup_network_domains (pool_id);
CREATE INDEX warmup_network_domains_status_idx ON warmup_network_domains (status);

CREATE TRIGGER trg_warmup_network_domains_set_updated_at
  BEFORE UPDATE ON warmup_network_domains
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE warmup_network_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES warmup_network_domains (id) ON DELETE RESTRICT,
  pool_id UUID NOT NULL REFERENCES warmup_network_pools (id) ON DELETE RESTRICT,
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365')),
  provider_mailbox_identifier TEXT NOT NULL CHECK (btrim(provider_mailbox_identifier) <> ''),
  mailbox_address TEXT NOT NULL CHECK (btrim(mailbox_address) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEGRADED', 'COOLDOWN', 'QUARANTINED', 'DISABLED')),
  health_score INTEGER NOT NULL DEFAULT 100 CHECK (health_score >= 0 AND health_score <= 100),
  reputation_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (reputation_state IN ('EXCELLENT', 'HEALTHY', 'DEGRADED', 'POOR', 'CRITICAL', 'UNKNOWN')),
  daily_capacity INTEGER NOT NULL DEFAULT 50 CHECK (daily_capacity >= 0),
  usage_date DATE NOT NULL DEFAULT (timezone('utc', now()))::date,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  last_successful_interaction_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  credential_available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_network_mailboxes_mailbox_id_unique UNIQUE (mailbox_id),
  CONSTRAINT warmup_network_mailboxes_mailbox_address_unique UNIQUE (mailbox_address)
);

CREATE INDEX warmup_network_mailboxes_domain_id_idx ON warmup_network_mailboxes (domain_id);
CREATE INDEX warmup_network_mailboxes_pool_id_idx ON warmup_network_mailboxes (pool_id);
CREATE INDEX warmup_network_mailboxes_status_idx ON warmup_network_mailboxes (status);

CREATE TRIGGER trg_warmup_network_mailboxes_set_updated_at
  BEFORE UPDATE ON warmup_network_mailboxes
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE warmup_network_routing_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routing_request_key TEXT NOT NULL CHECK (btrim(routing_request_key) <> ''),
  customer_tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  customer_mailbox_id UUID NOT NULL REFERENCES mailboxes (id) ON DELETE RESTRICT,
  selected_network_mailbox_id UUID REFERENCES warmup_network_mailboxes (id) ON DELETE RESTRICT,
  selected_domain_id UUID REFERENCES warmup_network_domains (id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SELECTED', 'CUSTOMER_MAILBOX_DISCONNECTED', 'NO_ELIGIBLE_WARMUP_MAILBOX')),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  eligibility_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warmup_network_routing_decisions_request_key_unique UNIQUE (routing_request_key)
);

CREATE INDEX warmup_network_routing_decisions_customer_mailbox_created_idx
  ON warmup_network_routing_decisions (customer_mailbox_id, created_at DESC);

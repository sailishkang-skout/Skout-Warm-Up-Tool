-- DNS-derived authentication posture for a sending domain (MX/SPF/DKIM/
-- DMARC). Deliberately keyed by domain, not by tenant or mailbox: DNS
-- reality is a property of the domain itself, not of who happens to be
-- asking — two tenants with mailboxes on the same domain must see the same
-- assessment, and re-checking DNS once per domain (not once per mailbox)
-- is exactly what Stage 7 spec section 16 asks for ("should not query
-- external infrastructure on every mailbox request").
--
-- One row per domain, replaced in place on each refresh (never a history
-- table) — historical mailbox-level assessments already capture "what did
-- domain intelligence say at time T" via mailbox_assessments.domain_assessment
-- (see 011_create_mailbox_assessments.sql), so this table only needs to hold
-- the current known state.

CREATE TABLE domain_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  mx_status TEXT NOT NULL CHECK (mx_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  mx_records JSONB NOT NULL DEFAULT '[]'::jsonb,
  spf_status TEXT NOT NULL CHECK (spf_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  spf_record TEXT,
  dkim_status TEXT NOT NULL CHECK (dkim_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dkim_selector TEXT,
  dmarc_status TEXT NOT NULL CHECK (dmarc_status IN ('PASS', 'FAIL', 'MISSING', 'UNKNOWN', 'ERROR')),
  dmarc_policy TEXT CHECK (dmarc_policy IN ('none', 'quarantine', 'reject')),
  dmarc_record TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT domain_intelligence_domain_unique UNIQUE (domain)
);

CREATE TRIGGER trg_domain_intelligence_set_updated_at
  BEFORE UPDATE ON domain_intelligence
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

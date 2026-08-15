-- email_address_canonical is deliberately NOT a full alias-folding
-- normalization (e.g. Gmail's dot-insensitivity and "+tag" stripping).
-- That behavior is Gmail-specific, not a general email standard, and other
-- providers (Microsoft 365, generic SMTP/IMAP) do not share it — folding it
-- in here would incorrectly conflate distinct mailboxes on those providers.
-- The canonical form only lowercases (domain names are case-insensitive by
-- DNS rules; the local part is lowercased too since virtually every
-- real-world provider treats it case-insensitively in practice, even though
-- RFC 5321 technically allows case sensitivity there). Provider-specific
-- alias folding belongs in the `providers` module, not this schema.
-- See src/modules/mailbox/domain/email-canonicalization.ts.

CREATE TABLE mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  email_address TEXT NOT NULL CHECK (btrim(email_address) <> ''),
  email_address_canonical TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (
    status IN (
      -- onboarding lifecycle
      'NEW', 'CONNECTING', 'CONNECTED', 'VALIDATING', 'ASSESSED',
      'WARMUP_INITIALIZED', 'WARMING', 'HEALTHY', 'OUTBOUND_READY', 'MONITORING',
      -- risk states
      'AT_RISK', 'RECOVERY', 'PAUSED', 'FAILED', 'DISCONNECTED'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mailboxes_tenant_email_canonical_unique UNIQUE (tenant_id, email_address_canonical)
);

CREATE TRIGGER trg_mailboxes_set_updated_at
  BEFORE UPDATE ON mailboxes
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX mailboxes_tenant_id_idx ON mailboxes (tenant_id);
CREATE INDEX mailboxes_status_idx ON mailboxes (status);

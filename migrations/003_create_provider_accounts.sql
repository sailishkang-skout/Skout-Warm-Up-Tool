-- Represents the connection/configuration relationship between a mailbox and
-- its external provider. Deliberately holds no credentials or tokens — only
-- non-secret metadata. `external_account_ref` is an opaque provider-supplied
-- identifier (e.g. a Google subject id or a Microsoft Graph object id), not a
-- secret; encrypted credential storage is a later stage's concern and will
-- live in its own table with its own access boundary, not here.
--
-- tenant_id is denormalized from mailboxes.tenant_id (rather than requiring
-- a join through mailboxes) so every tenant-scoped table can be filtered
-- directly by tenant_id — this is what makes tenant isolation something the
-- repository layer can enforce uniformly, not something that has to be
-- reconstructed per query. Repositories are responsible for keeping this in
-- sync with the owning mailbox's tenant_id at creation time.

CREATE TABLE provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'DISCONNECTED', 'ERROR')),
  external_account_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_accounts_mailbox_unique UNIQUE (mailbox_id)
);

CREATE TRIGGER trg_provider_accounts_set_updated_at
  BEFORE UPDATE ON provider_accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX provider_accounts_tenant_id_idx ON provider_accounts (tenant_id);
CREATE INDEX provider_accounts_mailbox_id_idx ON provider_accounts (mailbox_id);

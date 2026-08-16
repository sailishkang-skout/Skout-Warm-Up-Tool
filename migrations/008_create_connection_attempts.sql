-- Operational record of a single mailbox connection attempt (currently only
-- produced by the OAuth flows — see src/modules/oauth). Deliberately never
-- holds an authorization code, access token, or refresh token: this table
-- exists to answer "what happened and when," not to store anything a
-- credential-store row already owns.
--
-- tenant_id is denormalized from mailboxes.tenant_id, same rationale as
-- provider_accounts.tenant_id (003_create_provider_accounts.sql): every
-- tenant-scoped table can be filtered directly, without a join, so tenant
-- isolation is uniform across repositories.

CREATE TABLE connection_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  status TEXT NOT NULL DEFAULT 'STARTED'
    CHECK (status IN ('STARTED', 'AUTHORIZED', 'VALIDATING', 'SUCCEEDED', 'FAILED', 'EXPIRED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  failure_reason TEXT,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX connection_attempts_tenant_id_idx ON connection_attempts (tenant_id);
CREATE INDEX connection_attempts_mailbox_id_idx ON connection_attempts (mailbox_id);

CREATE TRIGGER trg_connection_attempts_set_updated_at
  BEFORE UPDATE ON connection_attempts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

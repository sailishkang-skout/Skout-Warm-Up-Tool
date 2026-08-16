-- Encrypted provider credentials — the only place a mailbox's OAuth
-- tokens/SMTP-IMAP password ever land in Postgres, and always as ciphertext.
-- `encrypted_payload` holds AES-256-GCM output (iv/authTag/ciphertext, all
-- base64) as a JSON string; the application never stores or accepts
-- plaintext here. `encryption_version` records which key encrypted this row
-- so a future key rotation can decrypt old rows under their original key
-- while new rows use the current one (see src/shared/crypto/encryption-service.ts).
--
-- Deliberately its own table, not a column on provider_accounts or
-- mailboxes: those tables are read constantly for ordinary mailbox
-- listing/status and must never have a reason to touch ciphertext, and this
-- table's access pattern (rare reads, by a single service boundary) is
-- different enough to warrant its own narrower blast radius.
--
-- Historical rows are never deleted — a mailbox disconnecting does not
-- revoke or remove its credential (see Stage 6 spec section 3); revocation
-- is an explicit status transition (`revoked_at` set, status -> REVOKED),
-- e.g. when a token is superseded by a fresh OAuth or refresh irrecoverably
-- fails. `provider_credentials_active_unique` enforces "at most one ACTIVE
-- credential per provider account at a time" without requiring a delete.

CREATE TABLE provider_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id UUID NOT NULL REFERENCES provider_accounts (id),
  credential_type TEXT NOT NULL CHECK (credential_type IN ('GOOGLE_OAUTH', 'MICROSOFT_OAUTH', 'SMTP', 'IMAP')),
  encrypted_payload TEXT NOT NULL,
  encryption_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX provider_credentials_active_unique
  ON provider_credentials (provider_account_id)
  WHERE status = 'ACTIVE';

CREATE INDEX provider_credentials_provider_account_id_idx ON provider_credentials (provider_account_id);

CREATE TRIGGER trg_provider_credentials_set_updated_at
  BEFORE UPDATE ON provider_credentials
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

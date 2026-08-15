-- Tenant-scoped API credentials. Only ever stores a lookup prefix (plaintext,
-- not secret) and a keyed hash of the secret half of the key — never the key
-- itself. See src/modules/auth/domain/api-key.ts and api-key-hash.ts for the
-- key format and hashing rationale.

CREATE TABLE api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- key_prefix is generated from 9 random bytes (see api-key.ts) — a
  -- collision here means a generation bug, not a legitimate duplicate, and
  -- should fail loudly rather than silently overwrite another credential's
  -- lookup entry.
  CONSTRAINT api_credentials_key_prefix_unique UNIQUE (key_prefix)
);

CREATE TRIGGER trg_api_credentials_set_updated_at
  BEFORE UPDATE ON api_credentials
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX api_credentials_tenant_id_idx ON api_credentials (tenant_id);
CREATE INDEX api_credentials_status_idx ON api_credentials (status);
-- No separate index on key_prefix: the UNIQUE constraint above already
-- creates one, which is also what authentication's lookup-by-prefix uses.

-- gen_random_uuid() is core as of PostgreSQL 13, but pgcrypto guarantees it's
-- available regardless of exact server version this service is deployed against.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Shared by every table below (and every future table) that has an
-- updated_at column: keeps "last modified" database-generated and
-- trustworthy instead of relying on every call site to remember to set it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX tenants_status_idx ON tenants (status);

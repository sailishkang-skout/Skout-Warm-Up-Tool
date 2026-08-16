-- Append-only log of individual measured signals feeding mailbox
-- intelligence (Stage 7 spec section 3/4) — the traceability trail behind
-- every health/risk/eligibility/capacity decision. Never a credential or
-- token: `value`/`metadata` hold only normalized, safe observations (a
-- connection status string, a DNS record's presence, a boolean capability).
--
-- `signal_type` is plain TEXT, not a CHECK-constrained enum, following the
-- same reasoning as audit_events.event_type (005_create_audit_events.sql):
-- the signal taxonomy is expected to grow as new sources become available
-- (delivery events, provider rate limits, ...), and the known Stage 7 set
-- lives as an application-level union type in
-- src/modules/mailbox-intelligence/domain/signal.ts.
--
-- tenant_id is denormalized from mailboxes.tenant_id, same rationale as
-- provider_accounts.tenant_id (003_create_provider_accounts.sql) — every
-- tenant-scoped table filterable directly by tenant_id.

CREATE TABLE mailbox_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  signal_type TEXT NOT NULL CHECK (btrim(signal_type) <> ''),
  value JSONB NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  observed_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mailbox_signals_tenant_id_idx ON mailbox_signals (tenant_id);
-- Supports "latest signal of type X for mailbox Y" — the actual read
-- pattern the health evaluator uses; not a speculative index.
CREATE INDEX mailbox_signals_mailbox_type_observed_idx
  ON mailbox_signals (mailbox_id, signal_type, observed_at DESC);

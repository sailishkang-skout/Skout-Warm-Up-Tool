-- Stage 10: append-only history of mailbox-level reputation assessments
-- (see reputation/README.md) — "what did Skout believe about this
-- mailbox's reputation yesterday" must always be answerable (Stage 10
-- spec section 20), same reasoning warmup_decisions already applies to
-- warmup decisions. Never updated or deleted by application code.
--
-- `factors`/`trends`/`last_24h`/`last_7d`/`lifetime` are JSONB, not
-- separate normalized tables — each row is a complete, self-contained
-- point-in-time snapshot (mirrors warmup_decisions.profile_snapshot's own
-- reasoning: an immutable capture, never reinterpreted by a later schema
-- change). No secrets: these hold only counts, rates, codes, and safe
-- descriptions (see reputation/domain/reputation-assessment.ts).

CREATE TABLE reputation_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  status TEXT NOT NULL CHECK (status IN ('EXCELLENT', 'HEALTHY', 'DEGRADED', 'POOR', 'CRITICAL', 'UNKNOWN')),
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  factors JSONB NOT NULL DEFAULT '[]'::jsonb,
  trends JSONB NOT NULL,
  last_24h JSONB NOT NULL,
  last_7d JSONB NOT NULL,
  lifetime JSONB NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reputation_assessments_tenant_id_idx ON reputation_assessments (tenant_id);
-- Supports "latest assessment for mailbox X" and bounded history listing —
-- the two actual read patterns application/reputation-service.ts uses.
CREATE INDEX reputation_assessments_mailbox_created_idx ON reputation_assessments (mailbox_id, created_at DESC);

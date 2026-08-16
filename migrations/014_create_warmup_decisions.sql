-- Append-only history of every warmup execution decision — Stage 8 spec
-- section 22: "Why was this mailbox paused? Why did volume decrease? Why
-- was execution blocked?" must always be answerable. Never updated or
-- deleted by application code; a new decision is always a new row.
--
-- `assessment_id` ties a decision back to the exact health-module
-- AssessmentSnapshot it was computed from. `profile_snapshot` is the
-- immutable configuration-at-decision-time capture Stage 8 spec section 23
-- asks for, so a later edit to warmup_profiles can never silently
-- reinterpret a historical decision.

CREATE TABLE warmup_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  session_id UUID NOT NULL REFERENCES warmup_sessions (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  warmup_day INTEGER NOT NULL CHECK (warmup_day >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('PROCEED', 'REDUCE', 'PAUSE', 'BLOCK', 'REVIEW')),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_volume INTEGER NOT NULL CHECK (recommended_volume >= 0),
  maximum_volume INTEGER NOT NULL CHECK (maximum_volume >= 0),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('ELIGIBLE', 'CONDITIONALLY_ELIGIBLE', 'NOT_ELIGIBLE', 'REQUIRES_REVIEW')),
  assessment_id UUID REFERENCES mailbox_assessments (id),
  profile_snapshot JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX warmup_decisions_tenant_id_idx ON warmup_decisions (tenant_id);
CREATE INDEX warmup_decisions_session_id_idx ON warmup_decisions (session_id, created_at DESC);

-- One row per point-in-time mailbox intelligence assessment — the
-- persisted output of MailboxIntelligenceService.refreshAssessment (health
-- + risk + eligibility + capacity, computed together from the same signal
-- set so they can never disagree about what was known at that moment).
-- Append-only: history and change detection (Stage 7 spec sections 17/18)
-- both depend on every prior assessment surviving, never being overwritten.
--
-- Structured columns for the fields history/change-detection/queries
-- actually filter or compare on (risk_level, eligibility_decision, the six
-- health dimensions); JSONB only for the bounded, already-safe detail that
-- has no independent query pattern of its own (risk_factors,
-- eligibility_reasons, capacity_reasons, the domain assessment snapshot).
-- Never holds a credential, token, or raw provider/DNS error.

CREATE TABLE mailbox_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),

  connection_health TEXT NOT NULL CHECK (connection_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  authentication_health TEXT NOT NULL CHECK (authentication_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  sending_health TEXT NOT NULL CHECK (sending_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  receiving_health TEXT NOT NULL CHECK (receiving_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  domain_health TEXT NOT NULL CHECK (domain_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),
  configuration_health TEXT NOT NULL CHECK (configuration_health IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN')),

  risk_level TEXT NOT NULL CHECK (risk_level IN ('UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  risk_score INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_factors JSONB NOT NULL DEFAULT '[]'::jsonb,

  eligibility_decision TEXT NOT NULL
    CHECK (eligibility_decision IN ('ELIGIBLE', 'CONDITIONALLY_ELIGIBLE', 'NOT_ELIGIBLE', 'REQUIRES_REVIEW')),
  eligibility_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,

  recommended_daily_volume INTEGER NOT NULL,
  minimum_daily_volume INTEGER NOT NULL,
  maximum_daily_volume INTEGER NOT NULL,
  capacity_confidence TEXT NOT NULL CHECK (capacity_confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  capacity_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,

  domain_assessment JSONB,

  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mailbox_assessments_tenant_id_idx ON mailbox_assessments (tenant_id);
-- Supports both "latest assessment for this mailbox" and "history, newest first".
CREATE INDEX mailbox_assessments_mailbox_assessed_at_idx ON mailbox_assessments (mailbox_id, assessed_at DESC);

-- Stage 14: conversation policy evaluations and signals. Additive —
-- migrations 001-024 are frozen. Signals only: no suppressions, sequences,
-- CRM, or warmup execution.

CREATE TABLE conversation_policy_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  source_message_id UUID REFERENCES conversation_messages (id),
  policy_version TEXT NOT NULL CHECK (btrim(policy_version) <> ''),
  taxonomy_version TEXT NOT NULL CHECK (btrim(taxonomy_version) <> ''),
  fact_set_hash TEXT NOT NULL CHECK (btrim(fact_set_hash) <> ''),
  fact_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EVALUATING', 'EVALUATED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evaluated_at TIMESTAMPTZ,
  CONSTRAINT conversation_policy_evaluations_fact_types_is_array
    CHECK (jsonb_typeof(fact_types) = 'array'),
  CONSTRAINT conversation_policy_evaluations_unique
    UNIQUE (tenant_id, source_message_id, policy_version, fact_set_hash)
);

CREATE INDEX conversation_policy_evaluations_tenant_id_idx
  ON conversation_policy_evaluations (tenant_id);

CREATE INDEX conversation_policy_evaluations_conversation_id_idx
  ON conversation_policy_evaluations (conversation_id, created_at ASC, id ASC);

CREATE INDEX conversation_policy_evaluations_claimable_idx
  ON conversation_policy_evaluations (next_attempt_at ASC, created_at ASC)
  WHERE status IN ('PENDING', 'EVALUATING');

CREATE TABLE conversation_policy_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  policy_evaluation_id UUID NOT NULL REFERENCES conversation_policy_evaluations (id),
  source_message_id UUID REFERENCES conversation_messages (id),
  signal TEXT NOT NULL CHECK (
    signal IN (
      'CONTACT_SUPPRESSION_REQUIRED',
      'TEMPORARY_CONTACT_PAUSE',
      'FOLLOW_UP_OPPORTUNITY',
      'MEETING_REQUESTED',
      'CONTACT_REVIEW_REQUIRED',
      'NEGATIVE_RESPONSE',
      'SPAM_SIGNAL',
      'OUT_OF_OFFICE',
      'REFERRAL_DETECTED',
      'QUESTION_DETECTED',
      'POSITIVE_RESPONSE'
    )
  ),
  priority TEXT NOT NULL CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  source_fact_type TEXT,
  source_fact_id UUID REFERENCES conversation_domain_facts (id),
  policy_version TEXT NOT NULL CHECK (btrim(policy_version) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_policy_signals_unique
    UNIQUE (policy_evaluation_id, signal)
);

CREATE INDEX conversation_policy_signals_tenant_id_idx
  ON conversation_policy_signals (tenant_id);

CREATE INDEX conversation_policy_signals_conversation_id_idx
  ON conversation_policy_signals (conversation_id, created_at ASC, id ASC);

CREATE INDEX conversation_policy_signals_message_id_idx
  ON conversation_policy_signals (source_message_id, created_at ASC, id ASC)
  WHERE source_message_id IS NOT NULL;

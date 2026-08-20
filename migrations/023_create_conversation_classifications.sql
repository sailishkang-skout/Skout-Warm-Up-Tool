-- Stage 13B: conversation message classification (facts only). Additive —
-- migrations 001-022 are frozen. This is not a policy/execution engine:
-- labels such as UNSUBSCRIBE are recorded facts, never suppressions or
-- sequence stops. Message bodies, prompts, and raw model responses are
-- not stored here.

CREATE TABLE conversation_message_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  message_id UUID NOT NULL REFERENCES conversation_messages (id),
  classifier_version TEXT NOT NULL CHECK (btrim(classifier_version) <> ''),
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  primary_label TEXT
    CHECK (
      primary_label IS NULL OR primary_label IN (
        'INTERESTED', 'MEETING_REQUEST', 'DEMO_REQUEST', 'PRICING_REQUEST', 'POSITIVE_REPLY',
        'NOT_INTERESTED', 'UNSUBSCRIBE', 'DO_NOT_CONTACT', 'WRONG_PERSON',
        'OOO', 'AUTO_REPLY', 'REFERRAL', 'QUESTION', 'BOUNCE_LIKE_CONTENT', 'NEEDS_HUMAN_REVIEW',
        'NEUTRAL', 'UNKNOWN'
      )
    ),
  confidence NUMERIC(4, 3)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_band TEXT CHECK (confidence_band IN ('HIGH', 'MEDIUM', 'LOW')),
  reason TEXT,
  model TEXT,
  input_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'CLASSIFIED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_message_classifications_unique
    UNIQUE (tenant_id, message_id, classifier_version),
  CONSTRAINT conversation_message_classifications_classified_shape CHECK (
    status <> 'CLASSIFIED' OR (
      jsonb_typeof(labels) = 'array'
      AND primary_label IS NOT NULL
      AND confidence IS NOT NULL
      AND confidence_band IS NOT NULL
      AND input_hash IS NOT NULL
    )
  )
);

CREATE INDEX conversation_message_classifications_tenant_id_idx
  ON conversation_message_classifications (tenant_id);

CREATE INDEX conversation_message_classifications_conversation_id_idx
  ON conversation_message_classifications (conversation_id, created_at DESC);

CREATE INDEX conversation_message_classifications_claimable_idx
  ON conversation_message_classifications (next_attempt_at)
  WHERE status IN ('PENDING', 'PROCESSING');

CREATE TRIGGER trg_conversation_message_classifications_set_updated_at
  BEFORE UPDATE ON conversation_message_classifications
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_classification_facts (
  conversation_id UUID PRIMARY KEY REFERENCES conversations (id),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  primary_label TEXT,
  needs_human_review BOOLEAN NOT NULL DEFAULT false,
  last_classified_message_id UUID REFERENCES conversation_messages (id),
  last_classified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX conversation_classification_facts_tenant_id_idx
  ON conversation_classification_facts (tenant_id);

CREATE TRIGGER trg_conversation_classification_facts_set_updated_at
  BEFORE UPDATE ON conversation_classification_facts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

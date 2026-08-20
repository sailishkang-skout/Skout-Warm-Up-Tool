-- Stage 13C: canonical taxonomy, classifier versioning, bounded evidence,
-- and append-only domain facts. Additive — migrations 001-023 are frozen.
-- Labels remain facts only: no suppressions, sequence stops, or CRM actions.

ALTER TABLE conversation_message_classifications
  ADD COLUMN IF NOT EXISTS taxonomy_version TEXT NOT NULL DEFAULT 'classification-taxonomy/v1'
    CHECK (btrim(taxonomy_version) <> ''),
  ADD COLUMN IF NOT EXISTS classifier_type TEXT
    CHECK (classifier_type IS NULL OR classifier_type IN ('DETERMINISTIC', 'AI', 'HYBRID')),
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE conversation_message_classifications
  DROP CONSTRAINT IF EXISTS conversation_message_classifications_primary_label_check;

ALTER TABLE conversation_message_classifications
  ADD CONSTRAINT conversation_message_classifications_primary_label_check
  CHECK (
    primary_label IS NULL OR primary_label IN (
      'INTERESTED', 'MEETING_REQUEST', 'DEMO_REQUEST', 'PRICING_REQUEST', 'POSITIVE_REPLY',
      'NOT_INTERESTED', 'UNSUBSCRIBE', 'DO_NOT_CONTACT', 'WRONG_PERSON',
      'OOO', 'AUTO_REPLY', 'REFERRAL', 'QUESTION', 'BOUNCE_LIKE_CONTENT', 'NEEDS_HUMAN_REVIEW',
      'NEUTRAL', 'UNKNOWN',
      'POSITIVE_INTEREST', 'NEGATIVE', 'SPAM'
    )
  );

ALTER TABLE conversation_message_classifications
  DROP CONSTRAINT IF EXISTS conversation_message_classifications_unique;

ALTER TABLE conversation_message_classifications
  ADD CONSTRAINT conversation_message_classifications_unique
    UNIQUE (tenant_id, message_id, classifier_version, taxonomy_version);

ALTER TABLE conversation_message_classifications
  DROP CONSTRAINT IF EXISTS conversation_message_classifications_evidence_is_array;

ALTER TABLE conversation_message_classifications
  ADD CONSTRAINT conversation_message_classifications_evidence_is_array
    CHECK (jsonb_typeof(evidence) = 'array');

CREATE TABLE conversation_domain_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  message_id UUID NOT NULL REFERENCES conversation_messages (id),
  classification_id UUID REFERENCES conversation_message_classifications (id),
  fact_type TEXT NOT NULL CHECK (
    fact_type IN (
      'MESSAGE_RECEIVED',
      'POSITIVE_INTEREST',
      'NEGATIVE_INTEREST',
      'UNSUBSCRIBE',
      'OOO',
      'WRONG_PERSON',
      'REFERRAL',
      'QUESTION',
      'MEETING_REQUEST',
      'SPAM'
    )
  ),
  classifier_version TEXT NOT NULL CHECK (btrim(classifier_version) <> ''),
  taxonomy_version TEXT NOT NULL CHECK (btrim(taxonomy_version) <> ''),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_domain_facts_unique
    UNIQUE (tenant_id, message_id, fact_type, classifier_version, taxonomy_version),
  CONSTRAINT conversation_domain_facts_evidence_is_array
    CHECK (jsonb_typeof(evidence) = 'array')
);

CREATE INDEX conversation_domain_facts_tenant_id_idx
  ON conversation_domain_facts (tenant_id);

CREATE INDEX conversation_domain_facts_conversation_id_idx
  ON conversation_domain_facts (conversation_id, created_at ASC, id ASC);

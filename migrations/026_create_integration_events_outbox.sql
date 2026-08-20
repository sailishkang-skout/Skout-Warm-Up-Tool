-- Stage 15: conversation intelligence integration-event outbox.
-- Additive — migrations 001-025 are frozen. This is not a generic event bus,
-- CRM/sequence store, suppression list, or publisher. Events are recorded
-- transactionally with policy signals. Delivery to external systems is
-- deferred; consumers pull via authenticated read. At-least-once + consumer
-- idempotency will be required when a publisher lands — this stage does not
-- claim exactly-once.

CREATE TABLE integration_events_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'CONVERSATION_UPDATED',
      'MESSAGE_RECEIVED',
      'MESSAGE_SENT',
      'CONTACT_SUPPRESSION_REQUIRED',
      'TEMPORARY_CONTACT_PAUSE',
      'FOLLOW_UP_OPPORTUNITY',
      'MEETING_REQUESTED',
      'CONTACT_REVIEW_REQUIRED',
      'NEGATIVE_RESPONSE',
      'SPAM_SIGNAL',
      'OUT_OF_OFFICE',
      'REFERRAL_DETECTED',
      'QUESTION_DETECTED'
    )
  ),
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'conversation'),
  aggregate_id UUID NOT NULL REFERENCES conversations (id),
  message_id UUID REFERENCES conversation_messages (id),
  occurred_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT,
  source_fact_id UUID REFERENCES conversation_domain_facts (id),
  source_policy_signal_id UUID REFERENCES conversation_policy_signals (id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  status TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status = 'RECORDED'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  last_error_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_events_outbox_event_id_unique UNIQUE (event_id),
  CONSTRAINT integration_events_outbox_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT integration_events_outbox_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX integration_events_outbox_tenant_id_idx
  ON integration_events_outbox (tenant_id, created_at ASC, event_id ASC);

CREATE INDEX integration_events_outbox_event_type_idx
  ON integration_events_outbox (tenant_id, event_type, created_at ASC, event_id ASC);

CREATE TRIGGER trg_integration_events_outbox_set_updated_at
  BEFORE UPDATE ON integration_events_outbox
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

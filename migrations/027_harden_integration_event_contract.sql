-- Stage 17: additive correlation columns on integration_events_outbox.
-- Does not rewrite payload JSONB, does not add a publisher/bus, and does
-- not change event_id identity. mailbox_id / execution_intent_id are
-- envelope correlation only. Historical payloads stay byte-identical.

ALTER TABLE integration_events_outbox
  ADD COLUMN source TEXT NOT NULL DEFAULT 'conversation-intelligence'
    CHECK (btrim(source) <> ''),
  ADD COLUMN mailbox_id UUID REFERENCES mailboxes (id),
  ADD COLUMN execution_intent_id UUID REFERENCES warmup_execution_intents (id);

UPDATE integration_events_outbox AS e
SET mailbox_id = c.mailbox_id
FROM conversations AS c
WHERE e.aggregate_id = c.id
  AND e.mailbox_id IS NULL;

UPDATE integration_events_outbox AS e
SET execution_intent_id = m.execution_intent_id
FROM conversation_messages AS m
WHERE e.message_id = m.id
  AND e.execution_intent_id IS NULL
  AND m.execution_intent_id IS NOT NULL;

CREATE INDEX integration_events_outbox_mailbox_id_idx
  ON integration_events_outbox (tenant_id, mailbox_id, created_at ASC, event_id ASC)
  WHERE mailbox_id IS NOT NULL;

-- Stage 13A: conversation facts layer (normalized EMAIL conversations/messages
-- + inbound poller lease state). Additive only — migrations 001-021 are
-- frozen. This is not an execution engine, sequence/CRM store, or AI
-- classification schema. html_body is nullable and Stage 13A application
-- code must persist NULL there (text_body only).

CREATE TABLE mailbox_inbound_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365')),
  cursor TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_inbound_sync_state_mailbox_unique UNIQUE (mailbox_id)
);

CREATE INDEX mailbox_inbound_sync_state_tenant_id_idx ON mailbox_inbound_sync_state (tenant_id);

CREATE INDEX mailbox_inbound_sync_state_claimable_idx
  ON mailbox_inbound_sync_state (lease_expires_at)
  WHERE lease_owner IS NULL OR lease_expires_at IS NOT NULL;

CREATE TRIGGER trg_mailbox_inbound_sync_state_set_updated_at
  BEFORE UPDATE ON mailbox_inbound_sync_state
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL', 'LINKEDIN')),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  provider_thread_id TEXT,
  synthetic_thread_key TEXT NOT NULL CHECK (btrim(synthetic_thread_key) <> ''),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'AWAITING_REPLY', 'REPLIED', 'CLOSED')),
  subject TEXT,
  first_message_at TIMESTAMPTZ NOT NULL,
  last_message_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_synthetic_thread_unique UNIQUE (tenant_id, mailbox_id, synthetic_thread_key)
);

CREATE UNIQUE INDEX conversations_provider_thread_unique
  ON conversations (tenant_id, mailbox_id, channel, provider, provider_thread_id)
  WHERE provider_thread_id IS NOT NULL;

CREATE INDEX conversations_tenant_id_idx ON conversations (tenant_id);
CREATE INDEX conversations_mailbox_id_idx ON conversations (mailbox_id);
CREATE INDEX conversations_last_message_at_idx ON conversations (last_message_at DESC);

CREATE TRIGGER trg_conversations_set_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  conversation_id UUID NOT NULL REFERENCES conversations (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  provider_message_id TEXT,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  "references" TEXT,
  sender TEXT NOT NULL CHECK (btrim(sender) <> ''),
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  execution_intent_id UUID REFERENCES warmup_execution_intents (id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_dedupe_key_unique UNIQUE (dedupe_key)
);

CREATE UNIQUE INDEX conversation_messages_provider_message_unique
  ON conversation_messages (tenant_id, mailbox_id, provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX conversation_messages_rfc_message_unique
  ON conversation_messages (tenant_id, mailbox_id, provider, rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

CREATE INDEX conversation_messages_conversation_sent_idx
  ON conversation_messages (conversation_id, sent_at ASC);

CREATE INDEX conversation_messages_tenant_id_idx ON conversation_messages (tenant_id);

CREATE INDEX conversation_messages_execution_intent_idx
  ON conversation_messages (execution_intent_id)
  WHERE execution_intent_id IS NOT NULL;

-- Stage 10: the normalized, provider-independent delivery evidence stream
-- `reputation`/`risk` compute over (see delivery-events/README.md). Never
-- updated or deleted by application code — a new event is always a new
-- row (Stage 10 spec section 24: "do not delete historical delivery
-- events"); duplicate provider redelivery is handled by `dedupe_key`
-- alone, never by mutating an existing row.
--
-- `event_type` is CHECK-constrained (unlike `mailbox_signals.signal_type`
-- / `audit_events.event_type`, which stay open TEXT) because this
-- vocabulary directly drives risk/safety decisions, the same reasoning
-- `warmup_execution_intents.status` already uses for its own safety-
-- critical, small, stable enum.
--
-- `dedupe_key` is the actual idempotency guard (Stage 10 spec section 3) —
-- deterministic from `tenant + provider + providerEventId` when the
-- provider supplies one, or a documented, less-precise fallback identity
-- when it doesn't (see delivery-events/domain/delivery-event.ts's
-- `computeDeliveryEventDedupeKey`). A single global UNIQUE constraint,
-- mirroring `warmup_execution_intents.idempotency_key` exactly — the key
-- already embeds tenant_id as its first component.

CREATE TABLE delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants (id),
  mailbox_id UUID NOT NULL REFERENCES mailboxes (id),
  execution_intent_id UUID REFERENCES warmup_execution_intents (id),
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'MICROSOFT365', 'SMTP_IMAP')),
  provider_event_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('DELIVERED', 'BOUNCED', 'FAILED', 'THROTTLED', 'DEFERRED', 'REJECTED', 'COMPLAINT', 'UNKNOWN')),
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (btrim(source) <> ''),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX delivery_events_tenant_id_idx ON delivery_events (tenant_id);
-- Supports the actual read pattern: reputation's rolling-window aggregate
-- query (WHERE mailbox_id = $1 AND observed_at >= $2 AND observed_at < $3
-- GROUP BY event_type) — not a speculative index.
CREATE INDEX delivery_events_mailbox_observed_idx ON delivery_events (mailbox_id, observed_at DESC);

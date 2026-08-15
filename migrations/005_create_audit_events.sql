-- Append-only security/business event log. `event_type` is deliberately
-- plain TEXT, not a CHECK-constrained enum like tenant/mailbox/credential
-- status: those are small, closed, rarely-changing sets; the audit event
-- taxonomy is open-ended and will keep growing across future stages
-- (policy decisions, health transitions, ...), and gating every new event
-- type behind a migration would fight that. The known Stage 4 values live
-- as an application-level union type in
-- src/modules/audit/domain/audit-event.ts.
--
-- tenant_id is nullable: some failures (e.g. an unparseable API key) never
-- resolve to a tenant at all, and the event is still worth recording.

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants (id),
  event_type TEXT NOT NULL CHECK (btrim(event_type) <> ''),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  request_id TEXT,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_id_idx ON audit_events (tenant_id);
CREATE INDEX audit_events_event_type_idx ON audit_events (event_type);
CREATE INDEX audit_events_created_at_idx ON audit_events (created_at);

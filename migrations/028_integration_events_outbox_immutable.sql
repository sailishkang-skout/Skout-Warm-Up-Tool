-- Stage 18: outbox rows are append-only. Application code never UPDATEs or
-- DELETEs integration events; this trigger makes that a database invariant.
-- Does not rewrite payload. TRUNCATE (test reset) is unaffected.
-- Migrations 001-027 are frozen.

CREATE OR REPLACE FUNCTION reject_integration_events_outbox_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'integration_events_outbox rows are immutable'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER trg_integration_events_outbox_immutable
  BEFORE UPDATE OR DELETE ON integration_events_outbox
  FOR EACH ROW
  EXECUTE FUNCTION reject_integration_events_outbox_mutation();

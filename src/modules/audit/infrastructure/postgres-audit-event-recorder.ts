import type { DatabaseClient } from "../../../shared/db/index.js";
import { sanitizeForLogging, type Logger } from "../../../shared/logger/index.js";
import type { AuditEventRecorder, RecordAuditEventInput } from "../application/audit-event-recorder.js";

export function createPostgresAuditEventRecorder(db: DatabaseClient, logger: Logger): AuditEventRecorder {
  return {
    async record(input: RecordAuditEventInput): Promise<void> {
      try {
        // Defense in depth: even though callers are expected to only ever
        // pass safe/structural metadata, redact anything sensitive-looking
        // before it reaches a durable, harder-to-purge store.
        const safeMetadata = sanitizeForLogging(input.metadata ?? {});

        await db.query(
          `INSERT INTO audit_events
             (tenant_id, event_type, actor_type, actor_id, request_id, correlation_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.tenantId ?? null,
            input.eventType,
            input.actorType,
            input.actorId ?? null,
            input.requestId ?? null,
            input.correlationId ?? null,
            JSON.stringify(safeMetadata),
          ],
        );
      } catch (error) {
        // Fail-open, deliberately: a failure to persist an audit row must
        // never block or fail the authentication/request flow it describes.
        // This is a foundation, not a durability guarantee — alerting on
        // audit-write failure is later hardening (Stage 14 per the
        // architecture doc), not Stage 4's job.
        logger.error({ err: error, eventType: input.eventType }, "Failed to record audit event");
      }
    },
  };
}

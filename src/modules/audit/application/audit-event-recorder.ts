import type { ApiCredentialId, TenantId } from "../../../shared/types/index.js";
import type { AuditActorType, AuditEventType } from "../domain/audit-event.js";

export interface RecordAuditEventInput {
  readonly tenantId?: TenantId;
  readonly eventType: AuditEventType;
  readonly actorType: AuditActorType;
  readonly actorId?: ApiCredentialId;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Port implemented by `infrastructure/postgres-audit-event-recorder.ts`. */
export interface AuditEventRecorder {
  record(input: RecordAuditEventInput): Promise<void>;
}

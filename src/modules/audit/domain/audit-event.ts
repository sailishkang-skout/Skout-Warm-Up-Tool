import type { ApiCredentialId, AuditEventId, TenantId } from "../../../shared/types/index.js";

/**
 * Open-ended by design — new event types get added here as later stages
 * need them (policy decisions, health transitions, ...). This union is the
 * only place Stage 4's set is enforced; the database column is plain TEXT
 * (see migrations/005_create_audit_events.sql) so adding one never requires
 * a migration.
 */
export const AUDIT_EVENT_TYPES = [
  "API_KEY_CREATED",
  "API_KEY_REVOKED",
  "API_KEY_ROTATED",
  "AUTHENTICATION_SUCCESS",
  "AUTHENTICATION_FAILURE",
  "TENANT_ACCESS_DENIED",
  "MAILBOX_CREATED",
  "MAILBOX_CONNECTION_STARTED",
  "MAILBOX_CONNECTION_SUCCEEDED",
  "MAILBOX_CONNECTION_FAILED",
  "MAILBOX_DISCONNECTED",
  "PROVIDER_CREDENTIAL_CREATED",
  "PROVIDER_CREDENTIAL_REVOKED",
  "OAUTH_STATE_REPLAY_DETECTED",
  "WARMUP_STARTED",
  "WARMUP_PAUSED",
  "WARMUP_RESUMED",
  "WARMUP_STOPPED",
  "WARMUP_DECISION_CREATED",
  "WARMUP_EXECUTION_BLOCKED",
  "WARMUP_INTENT_CREATED",
  "WARMUP_INTENT_CLAIMED",
  "WARMUP_EXECUTION_FAILED",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditActorType = "api_key" | "system";

/**
 * `metadata` must never hold a raw API key, an Authorization header, a
 * token, or a password — see `sanitizeForLogging` applied at the
 * infrastructure boundary (postgres-audit-event-recorder.ts) for the
 * defense-in-depth backstop, but callers constructing this are the first
 * line of defense: only put structural/safe data here.
 */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly tenantId?: TenantId;
  readonly eventType: AuditEventType;
  readonly actorType: AuditActorType;
  readonly actorId?: ApiCredentialId;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

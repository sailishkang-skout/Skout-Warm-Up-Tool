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
  "WARMUP_EXECUTION_UNKNOWN",
  "WARMUP_RECONCILIATION_REQUESTED",
  "WARMUP_INTENT_LEASE_RECLAIMED",
  "CONVERSATION_CREATED",
  "CONVERSATION_UPDATED",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
  "MESSAGE_CLASSIFIED",
  "CONVERSATION_CLASSIFIED",
  "CLASSIFICATION_FAILED",
  "DOMAIN_FACT_CREATED",
  "POLICY_EVALUATED",
  "POLICY_SIGNAL_CREATED",
  "DELIVERY_EVENT_RECEIVED",
  "DELIVERY_EVENT_DUPLICATE",
  "REPUTATION_ASSESSMENT_CREATED",
  "REPUTATION_DEGRADED",
  "REPUTATION_RECOVERED",
  "PROVIDER_REPUTATION_DEGRADED",
  "PROVIDER_REPUTATION_RECOVERED",
  "DOMAIN_REPUTATION_DEGRADED",
  "DOMAIN_REPUTATION_RECOVERED",
  "WARMUP_NETWORK_ROUTED",
  "WARMUP_MAILBOX_SELECTED",
  "WARMUP_MAILBOX_ROTATED",
  "WARMUP_MAILBOX_SKIPPED",
  "WARMUP_POOL_EXHAUSTED",
  "DOMAIN_CREATED",
  "DOMAIN_VERIFIED",
  "MAILBOX_PROVISIONED",
  "MAILBOX_SUSPENDED",
  "NETWORK_JOINED",
  "NETWORK_LEFT",
  "NETWORK_QUARANTINED",
  "NETWORK_PAUSED",
  "NETWORK_RESUMED",
  "MAILBOX_QUARANTINED",
  "MAILBOX_RESTORED",
  "MAILBOX_OPERATIONAL_STATUS_CHANGED",
  "PROVIDER_CONNECTED",
  "PROVIDER_DISCONNECTED",
  "KILL_SWITCH_ACTIVATED",
  "KILL_SWITCH_ENABLED",
  "KILL_SWITCH_DISABLED",
  "ROUTE_SELECTED",
  "ROUTE_REJECTED",
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

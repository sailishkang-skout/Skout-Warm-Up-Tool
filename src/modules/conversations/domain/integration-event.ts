import type {
  ConversationId,
  IntegrationEventId,
  MailboxId,
  MessageId,
  TenantId,
  WarmupExecutionIntentId,
} from "../../../shared/types/index.js";
import type { IntegrationEventType } from "./integration-event-taxonomy.js";

/**
 * Durable outbox envelope. Downstream CRM / sequence / suppression adapters
 * should depend on these types — not Postgres rows, repositories, or provider
 * adapters.
 *
 * Stable identity is `eventId` (unique UUID assigned at insert, never the
 * table PK `id`, never regenerated on read). `eventVersion` is the payload
 * `schema_version`. Delivery via `GET /api/v1/integration-events` is
 * **at-least-once**: consumers must dedupe on `eventId`. This service does
 * not claim exactly-once delivery, does not ACK outbox rows, and does not
 * mutate historical payloads.
 */
export interface IntegrationEventEnvelope {
  readonly eventId: IntegrationEventId;
  /**
   * Closed catalog for producers. Readers must treat this as an opaque string:
   * unknown future types are still delivered so pagination is not corrupted.
   */
  readonly eventType: IntegrationEventType | string;
  /** Payload schema version (`event_version` / `schema_version`). */
  readonly eventVersion: number;
  readonly tenantId: TenantId;
  readonly source: string;
  readonly conversationId: ConversationId;
  readonly messageId?: MessageId;
  readonly mailboxId?: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  /** Outbox insert time (pagination key). Present after persist. */
  readonly createdAt?: string;
  readonly occurredAt: string;
  readonly policyVersion?: string;
  readonly sourceFactId?: string;
  readonly sourcePolicySignalId?: string;
  readonly payload: IntegrationEventPayload;
  readonly idempotencyKey: string;
}

export type IntegrationEventPayload =
  | ContactSuppressionRequiredPayload
  | TemporaryContactPausePayload
  | FollowUpOpportunityPayload
  | MeetingRequestedPayload
  | ContactReviewRequiredPayload
  | NegativeResponsePayload
  | SpamSignalPayload
  | OutOfOfficePayload
  | ReferralDetectedPayload
  | QuestionDetectedPayload
  | ConversationLifecyclePayload;

/** Suppression consumer contract. Does not decide where suppression is stored. */
export interface ContactSuppressionRequiredPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "CRITICAL";
}

/** Sequence consumer: pause recommendation only. No step/wait/channel decisions. */
export interface TemporaryContactPausePayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "HIGH";
}

/** Sequence/CRM: interest or meeting follow-up is a fact, not a send. */
export interface FollowUpOpportunityPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "MEDIUM";
}

export interface MeetingRequestedPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "MEDIUM";
}

export interface ContactReviewRequiredPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "HIGH";
}

export interface NegativeResponsePayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "HIGH";
}

export interface SpamSignalPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "CRITICAL";
}

export interface OutOfOfficePayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "MEDIUM";
}

export interface ReferralDetectedPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "MEDIUM";
}

export interface QuestionDetectedPayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly contactIdentifier?: string;
  readonly reason: string;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: string;
  readonly priority: "LOW";
}

export interface ConversationLifecyclePayload {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly occurredAt: string;
}

export const SEQUENCE_CONSUMER_EVENT_TYPES = [
  "TEMPORARY_CONTACT_PAUSE",
  "FOLLOW_UP_OPPORTUNITY",
  "NEGATIVE_RESPONSE",
  "MEETING_REQUESTED",
] as const;

export const CRM_CONSUMER_EVENT_TYPES = [
  "FOLLOW_UP_OPPORTUNITY",
  "MEETING_REQUESTED",
  "CONTACT_REVIEW_REQUIRED",
  "REFERRAL_DETECTED",
] as const;

export const SUPPRESSION_CONSUMER_EVENT_TYPES = ["CONTACT_SUPPRESSION_REQUIRED"] as const;

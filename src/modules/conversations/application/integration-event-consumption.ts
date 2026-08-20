import type {
  ConversationId,
  IntegrationEventId,
  MailboxId,
  MessageId,
  TenantId,
  WarmupExecutionIntentId,
} from "../../../shared/types/index.js";
import type { IntegrationEventEnvelope, IntegrationEventPayload } from "../domain/integration-event.js";
import {
  INTEGRATION_CONTRACT_VERSION,
  INTEGRATION_EVENT_SOURCE,
  isIntegrationEventType,
} from "../domain/integration-event-taxonomy.js";

/** Matches `aggregate_type` in `integration_events_outbox` (migration 026). */
export const INTEGRATION_ENTITY_TYPE = "conversation" as const;

export const INTEGRATION_EVENTS_DEFAULT_PAGE_SIZE = 50;
export const INTEGRATION_EVENTS_MAX_PAGE_SIZE = 100;

export { INTEGRATION_CONTRACT_VERSION, INTEGRATION_EVENT_SOURCE };

/**
 * Pull consumption is **at-least-once**. There is no ACK, claim, or lease on
 * the outbox: concurrent GETs with the same cursor can return the same
 * `eventId`s. Consumers must dedupe on `eventId`. This service does not
 * claim exactly-once delivery.
 *
 * `schemaVersion` is `event_version` stored at write time — never inferred
 * from `eventType`, and historical payloads are not rewritten on read.
 *
 * Unknown `eventType` values are still returned (so keyset pagination cannot
 * skip rows). Consumers must ignore types they do not understand and still
 * advance their checkpoint.
 */
export interface IntegrationEventConsumerRecord {
  readonly eventId: IntegrationEventId;
  readonly tenantId: TenantId;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly entityType: typeof INTEGRATION_ENTITY_TYPE;
  readonly entityId: ConversationId;
  readonly payload: IntegrationEventPayload;
  readonly eventVersion: number;
  readonly conversationId: ConversationId;
  readonly messageId?: MessageId;
  readonly mailboxId?: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly policyVersion?: string;
  readonly sourceFactId?: string;
  readonly sourcePolicySignalId?: string;
  readonly idempotencyKey: string;
}

export interface IntegrationEventPage {
  readonly events: readonly IntegrationEventEnvelope[];
  readonly hasMore: boolean;
}

export interface IntegrationEventListResponse {
  readonly contractVersion: typeof INTEGRATION_CONTRACT_VERSION;
  readonly events: readonly IntegrationEventConsumerRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: IntegrationEventId;
}

export function sliceIntegrationEventPage(
  rows: readonly IntegrationEventEnvelope[],
  limit: number,
): IntegrationEventPage {
  const hasMore = rows.length > limit;
  return {
    events: hasMore ? rows.slice(0, limit) : rows,
    hasMore,
  };
}

export function toIntegrationEventConsumerRecord(
  event: IntegrationEventEnvelope,
): IntegrationEventConsumerRecord {
  return {
    eventId: event.eventId,
    tenantId: event.tenantId,
    eventType: event.eventType,
    schemaVersion: event.eventVersion,
    createdAt: event.createdAt ?? event.occurredAt,
    source: event.source,
    occurredAt: event.occurredAt,
    entityType: INTEGRATION_ENTITY_TYPE,
    entityId: event.conversationId,
    payload: event.payload,
    eventVersion: event.eventVersion,
    conversationId: event.conversationId,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.mailboxId ? { mailboxId: event.mailboxId } : {}),
    ...(event.executionIntentId ? { executionIntentId: event.executionIntentId } : {}),
    ...(event.policyVersion ? { policyVersion: event.policyVersion } : {}),
    ...(event.sourceFactId ? { sourceFactId: event.sourceFactId } : {}),
    ...(event.sourcePolicySignalId ? { sourcePolicySignalId: event.sourcePolicySignalId } : {}),
    idempotencyKey: event.idempotencyKey,
  };
}

export function toIntegrationEventListResponse(
  page: IntegrationEventPage,
): IntegrationEventListResponse {
  const last = page.events[page.events.length - 1];
  return {
    contractVersion: INTEGRATION_CONTRACT_VERSION,
    events: page.events.map(toIntegrationEventConsumerRecord),
    hasMore: page.hasMore,
    ...(page.hasMore && last ? { nextCursor: last.eventId } : {}),
  };
}

/** Consumers should skip processing, but still checkpoint, unknown types. */
export function isKnownIntegrationEventType(value: string): boolean {
  return isIntegrationEventType(value);
}

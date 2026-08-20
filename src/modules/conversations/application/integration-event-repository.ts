import type { ConversationId, IntegrationEventId, TenantId } from "../../../shared/types/index.js";
import type { IntegrationEventEnvelope } from "../domain/integration-event.js";
import type { IntegrationEventType } from "../domain/integration-event-taxonomy.js";

export interface ListIntegrationEventsQuery {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly eventType?: IntegrationEventType;
  /** Exclusive keyset cursor: durable `event_id`, tenant-scoped. */
  readonly afterEventId?: IntegrationEventId;
  readonly conversationId?: ConversationId;
}

export interface IntegrationEventRepository {
  insertIfAbsent(event: IntegrationEventEnvelope): Promise<IntegrationEventEnvelope | undefined>;
  list(query: ListIntegrationEventsQuery): Promise<readonly IntegrationEventEnvelope[]>;
  getByEventId(tenantId: TenantId, eventId: IntegrationEventId): Promise<IntegrationEventEnvelope | undefined>;
}

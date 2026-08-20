import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import {
  asConversationId,
  asIntegrationEventId,
  asMailboxId,
  asMessageId,
  asTenantId,
  asWarmupExecutionIntentId,
  type IntegrationEventId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { IntegrationEventEnvelope, IntegrationEventPayload } from "../domain/integration-event.js";
import { INTEGRATION_EVENT_SOURCE } from "../domain/integration-event-taxonomy.js";
import { INTEGRATION_EVENTS_MAX_PAGE_SIZE } from "../application/integration-event-consumption.js";
import type {
  IntegrationEventRepository,
  ListIntegrationEventsQuery,
} from "../application/integration-event-repository.js";

interface OutboxRow {
  event_id: string;
  event_type: string;
  event_version: number;
  tenant_id: string;
  source: string;
  aggregate_id: string;
  message_id: string | null;
  mailbox_id: string | null;
  execution_intent_id: string | null;
  created_at: Date;
  occurred_at: Date;
  policy_version: string | null;
  source_fact_id: string | null;
  source_policy_signal_id: string | null;
  payload: unknown;
  idempotency_key: string;
}

const OUTBOX_COLUMNS = `
  o.event_id, o.event_type, o.event_version, o.tenant_id, o.source,
  o.aggregate_id, o.message_id,
  COALESCE(o.mailbox_id, c.mailbox_id) AS mailbox_id,
  COALESCE(o.execution_intent_id, m.execution_intent_id) AS execution_intent_id,
  o.created_at, o.occurred_at, o.policy_version, o.source_fact_id, o.source_policy_signal_id,
  o.payload, o.idempotency_key
`;

const OUTBOX_FROM = `
  integration_events_outbox o
  LEFT JOIN conversations c ON c.id = o.aggregate_id
  LEFT JOIN conversation_messages m ON m.id = o.message_id
`;

function mapRow(row: OutboxRow): IntegrationEventEnvelope {
  return {
    eventId: asIntegrationEventId(row.event_id),
    eventType: row.event_type,
    eventVersion: row.event_version,
    tenantId: asTenantId(row.tenant_id),
    source: row.source || INTEGRATION_EVENT_SOURCE,
    conversationId: asConversationId(row.aggregate_id),
    ...(row.message_id ? { messageId: asMessageId(row.message_id) } : {}),
    ...(row.mailbox_id ? { mailboxId: asMailboxId(row.mailbox_id) } : {}),
    ...(row.execution_intent_id ? { executionIntentId: asWarmupExecutionIntentId(row.execution_intent_id) } : {}),
    createdAt: row.created_at.toISOString(),
    occurredAt: row.occurred_at.toISOString(),
    ...(row.policy_version ? { policyVersion: row.policy_version } : {}),
    ...(row.source_fact_id ? { sourceFactId: row.source_fact_id } : {}),
    ...(row.source_policy_signal_id ? { sourcePolicySignalId: row.source_policy_signal_id } : {}),
    payload: (row.payload ?? {}) as IntegrationEventPayload,
    idempotencyKey: row.idempotency_key,
  };
}

export async function insertIntegrationEvent(
  client: Database | DatabaseClient,
  event: IntegrationEventEnvelope,
): Promise<IntegrationEventEnvelope | undefined> {
  const rows = await client.query<OutboxRow>(
    `INSERT INTO integration_events_outbox (
       tenant_id, event_id, event_type, event_version, source, aggregate_type, aggregate_id,
       message_id, mailbox_id, execution_intent_id, occurred_at, policy_version, source_fact_id, source_policy_signal_id,
       payload, idempotency_key, status
     )
     VALUES ($1, $2, $3, $4, $5, 'conversation', $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, 'RECORDED')
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING event_id, event_type, event_version, tenant_id, source, aggregate_id, message_id,
               mailbox_id, execution_intent_id, created_at, occurred_at, policy_version,
               source_fact_id, source_policy_signal_id, payload, idempotency_key`,
    [
      event.tenantId,
      event.eventId,
      event.eventType,
      event.eventVersion,
      event.source || INTEGRATION_EVENT_SOURCE,
      event.conversationId,
      event.messageId ?? null,
      event.mailboxId ?? null,
      event.executionIntentId ?? null,
      new Date(event.occurredAt),
      event.policyVersion ?? null,
      event.sourceFactId ?? null,
      event.sourcePolicySignalId ?? null,
      JSON.stringify(event.payload),
      event.idempotencyKey,
    ],
  );
  return rows[0] ? mapRow(rows[0]) : undefined;
}

export class PostgresIntegrationEventRepository implements IntegrationEventRepository {
  constructor(private readonly db: Database) {}

  async insertIfAbsent(event: IntegrationEventEnvelope): Promise<IntegrationEventEnvelope | undefined> {
    return insertIntegrationEvent(this.db, event);
  }

  async list(query: ListIntegrationEventsQuery): Promise<readonly IntegrationEventEnvelope[]> {
    // Monotonic keyset: created_at + event_id. Insert time is used rather than
    // occurred_at so a later write with an earlier occurred_at cannot appear in
    // the middle of an in-flight consumer page. Cap at MAX+1 so routes can
    // detect hasMore without offset pagination.
    // Unknown event_type values are returned (not filtered) so a future type
    // cannot consume a LIMIT slot and vanish from the page.
    const limit = Math.min(Math.max(query.limit, 1), INTEGRATION_EVENTS_MAX_PAGE_SIZE + 1);
    const rows = await this.db.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS}
       FROM ${OUTBOX_FROM}
       WHERE o.tenant_id = $1
         AND ($2::text IS NULL OR o.event_type = $2)
         AND ($3::uuid IS NULL OR o.aggregate_id = $3)
         AND (
           $4::uuid IS NULL
           OR (o.created_at, o.event_id) > (
             SELECT created_at, event_id FROM integration_events_outbox
             WHERE tenant_id = $1 AND event_id = $4
           )
         )
       ORDER BY o.created_at ASC, o.event_id ASC
       LIMIT $5`,
      [
        query.tenantId,
        query.eventType ?? null,
        query.conversationId ?? null,
        query.afterEventId ?? null,
        limit,
      ],
    );
    return rows.map(mapRow);
  }

  async getByEventId(tenantId: TenantId, eventId: IntegrationEventId): Promise<IntegrationEventEnvelope | undefined> {
    const rows = await this.db.query<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS}
       FROM ${OUTBOX_FROM}
       WHERE o.tenant_id = $1 AND o.event_id = $2
       LIMIT 1`,
      [tenantId, eventId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

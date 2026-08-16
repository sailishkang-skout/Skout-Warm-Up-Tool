import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { sanitizeForLogging } from "../../../shared/logger/index.js";
import {
  asDeliveryEventId,
  asMailboxId,
  asTenantId,
  asWarmupExecutionIntentId,
  type MailboxId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { CreateDeliveryEventInput, DeliveryEventCounts, DeliveryEventRepository } from "../application/delivery-event-repository.js";
import { DELIVERY_EVENT_TYPES, type DeliveryEvent, type DeliveryEventSource, type DeliveryEventType } from "../domain/delivery-event.js";

interface DeliveryEventRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  execution_intent_id: string | null;
  provider: MailboxProviderType;
  provider_event_id: string | null;
  event_type: DeliveryEventType;
  observed_at: Date;
  source: DeliveryEventSource;
  metadata: Record<string, unknown>;
  created_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, execution_intent_id, provider, provider_event_id,
  event_type, observed_at, source, metadata, created_at
`;

function mapRow(row: DeliveryEventRow): DeliveryEvent {
  return {
    id: asDeliveryEventId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    ...(row.execution_intent_id ? { executionIntentId: asWarmupExecutionIntentId(row.execution_intent_id) } : {}),
    provider: row.provider,
    ...(row.provider_event_id ? { providerEventId: row.provider_event_id } : {}),
    eventType: row.event_type,
    observedAt: row.observed_at,
    source: row.source,
    ...(row.metadata && Object.keys(row.metadata).length > 0 ? { metadata: row.metadata } : {}),
    createdAt: row.created_at,
  };
}

function zeroCounts(): Record<DeliveryEventType, number> {
  const counts = {} as Record<DeliveryEventType, number>;
  for (const type of DELIVERY_EVENT_TYPES) {
    counts[type] = 0;
  }
  return counts;
}

export class PostgresDeliveryEventRepository implements DeliveryEventRepository {
  constructor(private readonly db: DatabaseClient) {}

  async recordIfAbsent(input: CreateDeliveryEventInput): Promise<{ event: DeliveryEvent; wasNew: boolean }> {
    const inserted = await this.db.query<DeliveryEventRow>(
      `INSERT INTO delivery_events (
         tenant_id, mailbox_id, execution_intent_id, provider, provider_event_id,
         event_type, observed_at, source, metadata, dedupe_key
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.executionIntentId ?? null,
        input.provider,
        input.providerEventId ?? null,
        input.eventType,
        input.observedAt,
        input.source,
        // Defense in depth (same pattern as postgres-audit-event-recorder.ts):
        // callers are expected to only ever pass safe/structural metadata,
        // but this is a durable, harder-to-purge store, so redact anything
        // sensitive-looking before it reaches Postgres.
        JSON.stringify(sanitizeForLogging(input.metadata ?? {})),
        input.dedupeKey,
      ],
    );
    if (inserted[0]) {
      return { event: mapRow(inserted[0]), wasNew: true };
    }

    // Lost the insert race, or a genuine redelivery — Stage 10 spec section
    // 3: a duplicate must never create a second logical event. Same
    // ON CONFLICT DO NOTHING + re-select pattern as
    // PostgresWarmupExecutionIntentRepository.createIfAbsent.
    const existing = await this.db.query<DeliveryEventRow>(
      `SELECT ${SELECT_COLUMNS} FROM delivery_events WHERE dedupe_key = $1`,
      [input.dedupeKey],
    );
    return { event: mapRow(expectOne(existing, "delivery_events dedupe lookup")), wasNew: false };
  }

  async countByEventType(tenantId: TenantId, mailboxId: MailboxId, windowStart: Date, windowEnd: Date): Promise<DeliveryEventCounts> {
    const rows = await this.db.query<{ event_type: DeliveryEventType; count: string }>(
      `SELECT event_type, COUNT(*)::text AS count
       FROM delivery_events
       WHERE tenant_id = $1 AND mailbox_id = $2 AND observed_at >= $3 AND observed_at < $4
       GROUP BY event_type`,
      [tenantId, mailboxId, windowStart, windowEnd],
    );
    const counts = zeroCounts();
    for (const row of rows) {
      counts[row.event_type] = Number.parseInt(row.count, 10);
    }
    return counts;
  }
}

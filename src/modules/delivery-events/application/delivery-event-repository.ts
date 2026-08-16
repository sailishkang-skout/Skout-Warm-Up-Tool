import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";
import type { DeliveryEvent, DeliveryEventSource, DeliveryEventType } from "../domain/delivery-event.js";

export interface CreateDeliveryEventInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly provider: MailboxProviderType;
  readonly providerEventId?: string;
  readonly eventType: DeliveryEventType;
  readonly observedAt: Date;
  readonly source: DeliveryEventSource;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
}

/** Counts per event type within `[windowStart, windowEnd)`, plus the total row count actually aggregated. */
export type DeliveryEventCounts = Readonly<Record<DeliveryEventType, number>>;

/**
 * Port implemented by `infrastructure/postgres-delivery-event-repository.ts`.
 * Append-only (Stage 10 spec section 24: "do not delete historical delivery
 * events") — there is no update/delete method on this interface at all.
 */
export interface DeliveryEventRepository {
  /**
   * Idempotent by `dedupeKey` (Stage 10 spec section 3) — a duplicate
   * ingestion returns the existing row and `wasNew: false` rather than
   * inserting a second logical event or throwing. Mirrors
   * `WarmupExecutionIntentRepository.createIfAbsent`'s `ON CONFLICT DO
   * NOTHING` + re-select pattern exactly, for the same reason: concurrent
   * duplicate requests must never race into two rows.
   */
  recordIfAbsent(input: CreateDeliveryEventInput): Promise<{ readonly event: DeliveryEvent; readonly wasNew: boolean }>;
  /**
   * A single grouped-aggregate query over `[windowStart, windowEnd)` —
   * never an unbounded scan, never N+1 (Stage 10 spec section 7/18). Every
   * `DeliveryEventType` is always present in the result, `0` for types
   * with no rows in the window (an explicit, deliberate count of zero —
   * not to be confused with `reputation`'s own `UNKNOWN` rate semantics,
   * which are about *missing evidence*, not *zero observed events*; the
   * caller derives one from the other).
   */
  countByEventType(tenantId: TenantId, mailboxId: MailboxId, windowStart: Date, windowEnd: Date): Promise<DeliveryEventCounts>;
}

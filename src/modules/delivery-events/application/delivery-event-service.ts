import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { AssessmentInvalidationStore } from "../../health/application/assessment-invalidation-store.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";
import { computeDeliveryEventDedupeKey, type DeliveryEvent, type DeliveryEventSource, type DeliveryEventType } from "../domain/delivery-event.js";
import type { DeliveryEventRepository } from "./delivery-event-repository.js";

export interface IngestDeliveryEventInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly provider: MailboxProviderType;
  readonly providerEventId?: string;
  readonly eventType: DeliveryEventType;
  readonly observedAt: Date;
  readonly source: DeliveryEventSource;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface IngestDeliveryEventResult {
  readonly event: DeliveryEvent;
  readonly wasNew: boolean;
}

/** Window aggregation, re-exported so callers (`reputation`) never import the repository/infrastructure layer directly. */
export interface DeliveryEventWindowStats {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly counts: Readonly<Record<DeliveryEventType, number>>;
  readonly total: number;
}

export interface DeliveryEventService {
  /**
   * Stage 10 spec section 4's ingestion pipeline: verify ownership, check
   * idempotency, persist, mark the mailbox's intelligence stale, audit —
   * and nothing else. Deliberately does NOT touch warmup volume, a
   * `WarmupSession`, or a `WarmupDecision` (section 4: "The ingestion
   * service must NOT directly manipulate warmup volume" — that only ever
   * happens through `reputation` → `risk` → the existing decision engine).
   */
  ingestDeliveryEvent(input: IngestDeliveryEventInput): Promise<IngestDeliveryEventResult>;
  getWindowStats(tenantId: TenantId, mailboxId: MailboxId, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats>;
  /** Stage 11: same window-stats shape, aggregated across every mailbox this tenant sends through `provider` instead of one mailbox. */
  getProviderWindowStats(tenantId: TenantId, provider: MailboxProviderType, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats>;
  /** Stage 11: same window-stats shape, aggregated across every mailbox this tenant sends through the given sending domain. */
  getDomainWindowStats(tenantId: TenantId, domain: string, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats>;
}

export interface CreateDeliveryEventServiceDeps {
  readonly deliveryEventRepository: DeliveryEventRepository;
  readonly mailboxService: MailboxService;
  /**
   * The narrow staleness-marker port, not the full `MailboxAssessmentService`
   * — `delivery-events` only ever needs to say "something changed, please
   * recompute next time," never to read or drive an assessment itself.
   * Depending on the narrow port instead of the full service also avoids a
   * module dependency cycle: `health`'s own assessment service depends on
   * `reputation`, which depends on this module.
   */
  readonly invalidationStore: AssessmentInvalidationStore;
  readonly auditRecorder: AuditEventRecorder;
}

export function createDeliveryEventService(deps: CreateDeliveryEventServiceDeps): DeliveryEventService {
  const { deliveryEventRepository, mailboxService, invalidationStore, auditRecorder } = deps;

  return {
    async ingestDeliveryEvent(input: IngestDeliveryEventInput): Promise<IngestDeliveryEventResult> {
      // Ownership check (Stage 10 spec section 4.2 / 22): getMailbox throws
      // NotFoundError for a mailbox that doesn't belong to this tenant —
      // the same tenant-isolation enforcement every other module already
      // relies on, never re-implemented here.
      await mailboxService.getMailbox(input.tenantId, input.mailboxId);

      const dedupeKey = computeDeliveryEventDedupeKey({
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        provider: input.provider,
        eventType: input.eventType,
        observedAt: input.observedAt,
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        ...(input.executionIntentId ? { executionIntentId: input.executionIntentId } : {}),
      });

      const { event, wasNew } = await deliveryEventRepository.recordIfAbsent({
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        provider: input.provider,
        eventType: input.eventType,
        observedAt: input.observedAt,
        source: input.source,
        dedupeKey,
        ...(input.executionIntentId ? { executionIntentId: input.executionIntentId } : {}),
        ...(input.providerEventId ? { providerEventId: input.providerEventId } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });

      if (!wasNew) {
        // Duplicate delivery (Stage 10 spec section 3): never re-mark
        // intelligence stale, never re-audit as "received" a second time —
        // a distinct, safe-to-ignore audit trail entry instead.
        await auditRecorder.record({
          tenantId: input.tenantId,
          eventType: "DELIVERY_EVENT_DUPLICATE",
          actorType: "system",
          metadata: { mailboxId: input.mailboxId, deliveryEventId: event.id, eventType: event.eventType },
        });
        return { event, wasNew };
      }

      // Stage 10 spec section 17: never a synchronous full reassessment
      // here — just a lightweight marker so the next warmup decision (or
      // an explicit refresh) recomputes with this evidence included.
      await invalidationStore.markStale(input.tenantId, input.mailboxId);

      await auditRecorder.record({
        tenantId: input.tenantId,
        eventType: "DELIVERY_EVENT_RECEIVED",
        actorType: "system",
        metadata: { mailboxId: input.mailboxId, deliveryEventId: event.id, eventType: event.eventType, provider: event.provider, source: event.source },
      });

      return { event, wasNew };
    },

    async getWindowStats(tenantId: TenantId, mailboxId: MailboxId, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats> {
      const counts = await deliveryEventRepository.countByEventType(tenantId, mailboxId, windowStart, windowEnd);
      return toWindowStats(windowStart, windowEnd, counts);
    },

    async getProviderWindowStats(tenantId: TenantId, provider: MailboxProviderType, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats> {
      const counts = await deliveryEventRepository.countByEventTypeForProvider(tenantId, provider, windowStart, windowEnd);
      return toWindowStats(windowStart, windowEnd, counts);
    },

    async getDomainWindowStats(tenantId: TenantId, domain: string, windowStart: Date, windowEnd: Date): Promise<DeliveryEventWindowStats> {
      const counts = await deliveryEventRepository.countByEventTypeForDomain(tenantId, domain, windowStart, windowEnd);
      return toWindowStats(windowStart, windowEnd, counts);
    },
  };
}

function toWindowStats(windowStart: Date, windowEnd: Date, counts: Readonly<Record<DeliveryEventType, number>>): DeliveryEventWindowStats {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { windowStart, windowEnd, counts, total };
}

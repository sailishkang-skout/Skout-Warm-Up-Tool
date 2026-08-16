import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { DeliveryEventService } from "../../delivery-events/application/delivery-event-service.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { ReputationAssessment, ReputationStatus } from "../domain/reputation-assessment.js";
import { evaluateReputation } from "./reputation-policy.js";
import type { ReputationRepository } from "./reputation-repository.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const EPOCH = new Date(0);

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Statuses serious enough to be worth a distinct, explicit audit trail
 * entry beyond the routine `REPUTATION_ASSESSMENT_CREATED` every run
 * produces (Stage 10 spec section 21).
 */
const DEGRADED_STATUSES: ReadonlySet<ReputationStatus> = new Set(["DEGRADED", "POOR", "CRITICAL"]);

export interface ReputationService {
  /**
   * Always computes fresh from current delivery-event evidence and
   * persists a new append-only row (Stage 10 spec section 20) — the write
   * path, called only by `health`'s `MailboxAssessmentService.performRefresh`
   * (which already owns the staleness/rate-limit decision of *when* to
   * recompute; this function does not re-implement that).
   */
  assessReputation(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment>;
  /** The most recently persisted assessment, or `undefined` if this mailbox has never been assessed yet. Read-only — never triggers a computation. */
  getLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment | undefined>;
  getHistory(tenantId: TenantId, mailboxId: MailboxId, limit?: number): Promise<ReputationAssessment[]>;
}

export interface CreateReputationServiceDeps {
  readonly deliveryEventService: DeliveryEventService;
  readonly reputationRepository: ReputationRepository;
  readonly auditRecorder: AuditEventRecorder;
}

export function createReputationService(deps: CreateReputationServiceDeps): ReputationService {
  const { deliveryEventService, reputationRepository, auditRecorder } = deps;

  return {
    async assessReputation(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment> {
      const now = new Date();
      const [last24h, prior24h, last7d, lifetime] = await Promise.all([
        deliveryEventService.getWindowStats(tenantId, mailboxId, new Date(now.getTime() - DAY_MS), now),
        deliveryEventService.getWindowStats(tenantId, mailboxId, new Date(now.getTime() - 2 * DAY_MS), new Date(now.getTime() - DAY_MS)),
        deliveryEventService.getWindowStats(tenantId, mailboxId, new Date(now.getTime() - WEEK_MS), now),
        deliveryEventService.getWindowStats(tenantId, mailboxId, EPOCH, now),
      ]);

      const previous = await reputationRepository.findLatest(tenantId, mailboxId);

      const result = evaluateReputation({
        last24h: last24h.counts,
        prior24h: prior24h.counts,
        last7d: last7d.counts,
        lifetime: lifetime.counts,
      });

      const assessment = await reputationRepository.create({
        tenantId,
        mailboxId,
        snapshot: { ...result, assessedAt: now },
      });

      await auditRecorder.record({
        tenantId,
        eventType: "REPUTATION_ASSESSMENT_CREATED",
        actorType: "system",
        metadata: { mailboxId, reputationAssessmentId: assessment.id, status: assessment.status, confidence: assessment.confidence },
      });

      if (DEGRADED_STATUSES.has(assessment.status) && (!previous || !DEGRADED_STATUSES.has(previous.status))) {
        await auditRecorder.record({
          tenantId,
          eventType: "REPUTATION_DEGRADED",
          actorType: "system",
          metadata: { mailboxId, reputationAssessmentId: assessment.id, status: assessment.status, previousStatus: previous?.status ?? "UNKNOWN" },
        });
      } else if (!DEGRADED_STATUSES.has(assessment.status) && previous && DEGRADED_STATUSES.has(previous.status)) {
        await auditRecorder.record({
          tenantId,
          eventType: "REPUTATION_RECOVERED",
          actorType: "system",
          metadata: { mailboxId, reputationAssessmentId: assessment.id, status: assessment.status, previousStatus: previous.status },
        });
      }

      return assessment;
    },

    async getLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment | undefined> {
      return reputationRepository.findLatest(tenantId, mailboxId);
    },

    async getHistory(tenantId: TenantId, mailboxId: MailboxId, limit = DEFAULT_HISTORY_LIMIT): Promise<ReputationAssessment[]> {
      const boundedLimit = Math.min(Math.max(1, limit), MAX_HISTORY_LIMIT);
      return reputationRepository.listHistory(tenantId, mailboxId, boundedLimit);
    },
  };
}

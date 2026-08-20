import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { DeliveryEventService, DeliveryEventWindowStats } from "../../delivery-events/application/delivery-event-service.js";
import type { DomainIntelligenceService } from "../../domain-intelligence/application/domain-intelligence-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { DomainReputationSnapshot, ProviderReputationSnapshot, ReputationAssessment, ReputationStatus } from "../domain/reputation-assessment.js";
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

/**
 * `emailAddressCanonical` is always `local@domain`, already lowercased at
 * write time (see migrations/002_create_mailboxes.sql) — this is the exact
 * same one-line extraction `health/application/mailbox-assessment-service.ts`
 * already uses; duplicated rather than shared since it's a trivial pure
 * function and the alternative (a cross-module utility import for one line)
 * would be more coupling than the duplication itself.
 */
function extractDomain(emailAddressCanonical: string): string {
  return emailAddressCanonical.slice(emailAddressCanonical.lastIndexOf("@") + 1);
}

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
  /** Stage 11: needed to resolve the mailbox's `provider` and sending domain — the two new aggregation scopes. */
  readonly mailboxService: MailboxService;
  /** Stage 11: reused for the domain's MX/SPF/DKIM/DMARC facts embedded in `domainReputation.authentication` — never a second DNS resolver (Stage 11 spec section 3: "do not duplicate DNS checks"). */
  readonly domainIntelligenceService: DomainIntelligenceService;
}

/** One factor code + severity transition audit pair, keyed by which audit event types fire for that scope. */
function degradedTransitionEvents(scope: "" | "PROVIDER_" | "DOMAIN_"): { degraded: "REPUTATION_DEGRADED" | "PROVIDER_REPUTATION_DEGRADED" | "DOMAIN_REPUTATION_DEGRADED"; recovered: "REPUTATION_RECOVERED" | "PROVIDER_REPUTATION_RECOVERED" | "DOMAIN_REPUTATION_RECOVERED" } {
  if (scope === "PROVIDER_") return { degraded: "PROVIDER_REPUTATION_DEGRADED", recovered: "PROVIDER_REPUTATION_RECOVERED" };
  if (scope === "DOMAIN_") return { degraded: "DOMAIN_REPUTATION_DEGRADED", recovered: "DOMAIN_REPUTATION_RECOVERED" };
  return { degraded: "REPUTATION_DEGRADED", recovered: "REPUTATION_RECOVERED" };
}

export function createReputationService(deps: CreateReputationServiceDeps): ReputationService {
  const { deliveryEventService, reputationRepository, auditRecorder, mailboxService, domainIntelligenceService } = deps;

  async function fetchWindows(
    statsFn: (windowStart: Date, windowEnd: Date) => Promise<DeliveryEventWindowStats>,
    now: Date,
  ): Promise<{ last24h: DeliveryEventWindowStats; prior24h: DeliveryEventWindowStats; last7d: DeliveryEventWindowStats; lifetime: DeliveryEventWindowStats }> {
    const [last24h, prior24h, last7d, lifetime] = await Promise.all([
      statsFn(new Date(now.getTime() - DAY_MS), now),
      statsFn(new Date(now.getTime() - 2 * DAY_MS), new Date(now.getTime() - DAY_MS)),
      statsFn(new Date(now.getTime() - WEEK_MS), now),
      statsFn(EPOCH, now),
    ]);
    return { last24h, prior24h, last7d, lifetime };
  }

  return {
    async assessReputation(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment> {
      const now = new Date();
      const mailbox = await mailboxService.getMailbox(tenantId, mailboxId);
      const domain = extractDomain(mailbox.emailAddressCanonical);

      const [mailboxWindows, providerWindows, domainWindows, domainAssessment, previous] = await Promise.all([
        fetchWindows((start, end) => deliveryEventService.getWindowStats(tenantId, mailboxId, start, end), now),
        fetchWindows((start, end) => deliveryEventService.getProviderWindowStats(tenantId, mailbox.provider, start, end), now),
        fetchWindows((start, end) => deliveryEventService.getDomainWindowStats(tenantId, domain, start, end), now),
        domainIntelligenceService.getAssessment(domain),
        reputationRepository.findLatest(tenantId, mailboxId),
      ]);

      const mailboxResult = evaluateReputation({
        last24h: mailboxWindows.last24h.counts,
        prior24h: mailboxWindows.prior24h.counts,
        last7d: mailboxWindows.last7d.counts,
        lifetime: mailboxWindows.lifetime.counts,
      });
      const providerResult = evaluateReputation(
        { last24h: providerWindows.last24h.counts, prior24h: providerWindows.prior24h.counts, last7d: providerWindows.last7d.counts, lifetime: providerWindows.lifetime.counts },
        { codePrefix: "PROVIDER_" },
      );
      const domainResult = evaluateReputation(
        { last24h: domainWindows.last24h.counts, prior24h: domainWindows.prior24h.counts, last7d: domainWindows.last7d.counts, lifetime: domainWindows.lifetime.counts },
        { codePrefix: "DOMAIN_" },
      );

      const providerReputation: ProviderReputationSnapshot = { provider: mailbox.provider, ...providerResult };
      const domainReputation: DomainReputationSnapshot = {
        domain,
        ...domainResult,
        authentication: {
          mx: domainAssessment.mx.status,
          spf: domainAssessment.spf.status,
          dkim: domainAssessment.dkim.status,
          dmarc: domainAssessment.dmarc.status,
        },
      };

      const assessment = await reputationRepository.create({
        tenantId,
        mailboxId,
        snapshot: { ...mailboxResult, providerReputation, domainReputation, assessedAt: now },
      });

      await auditRecorder.record({
        tenantId,
        eventType: "REPUTATION_ASSESSMENT_CREATED",
        actorType: "system",
        metadata: {
          mailboxId,
          reputationAssessmentId: assessment.id,
          status: assessment.status,
          confidence: assessment.confidence,
          providerStatus: assessment.providerReputation.status,
          domainStatus: assessment.domainReputation.status,
        },
      });

      await recordTransitionAudit("", assessment.status, previous?.status);
      await recordTransitionAudit("PROVIDER_", assessment.providerReputation.status, previous?.providerReputation.status);
      await recordTransitionAudit("DOMAIN_", assessment.domainReputation.status, previous?.domainReputation.status);

      async function recordTransitionAudit(scope: "" | "PROVIDER_" | "DOMAIN_", status: ReputationStatus, previousStatus: ReputationStatus | undefined): Promise<void> {
        const events = degradedTransitionEvents(scope);
        if (DEGRADED_STATUSES.has(status) && (previousStatus === undefined || !DEGRADED_STATUSES.has(previousStatus))) {
          await auditRecorder.record({
            tenantId,
            eventType: events.degraded,
            actorType: "system",
            metadata: { mailboxId, reputationAssessmentId: assessment.id, status, previousStatus: previousStatus ?? "UNKNOWN" },
          });
        } else if (!DEGRADED_STATUSES.has(status) && previousStatus !== undefined && DEGRADED_STATUSES.has(previousStatus)) {
          await auditRecorder.record({
            tenantId,
            eventType: events.recovered,
            actorType: "system",
            metadata: { mailboxId, reputationAssessmentId: assessment.id, status, previousStatus },
          });
        }
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

import type { DomainIntelligenceService } from "../../domain-intelligence/application/domain-intelligence-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { recommendCapacity } from "../../policy/application/capacity-policy.js";
import { evaluateEligibility } from "../../policy/application/warmup-eligibility-policy.js";
import type { ReputationService } from "../../reputation/application/reputation-service.js";
import { evaluateRisk } from "../../risk/application/risk-policy.js";
import { RateLimitError } from "../../../shared/errors/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { AssessmentInvalidationStore } from "./assessment-invalidation-store.js";
import { computeFreshness } from "../domain/freshness.js";
import type { AssessmentSnapshot } from "../domain/assessment-snapshot.js";
import { evaluateHealth } from "./mailbox-health-evaluator.js";
import type { MailboxAssessmentRepository } from "./mailbox-assessment-repository.js";
import type { MailboxSignalRepository } from "./mailbox-signal-repository.js";
import { collectSignals } from "./signal-collector.js";

/**
 * The orchestrator called for by Stage-7-boundary-refactor section 2 —
 * calls into `domain-intelligence`, `risk`, and `policy` to produce one
 * `AssessmentSnapshot`, but is itself owned by `health` since health
 * (raw-signal collection + evaluation) is the pipeline's entry point. The
 * pure policy modules it calls never call back into this module or into
 * each other's infrastructure, so the dependency direction stays one-way:
 * this service → risk/policy application functions → their own domain
 * types only.
 */
export interface MailboxAssessmentService {
  /** Returns the latest assessment, computing a fresh one first if none exists or the latest has gone stale. */
  getAssessment(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot>;
  /** Forces recomputation. Rate-limited — see REFRESH_MIN_INTERVAL_MS. */
  refreshAssessment(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot>;
  getHistory(tenantId: TenantId, mailboxId: MailboxId, limit?: number): Promise<AssessmentSnapshot[]>;
}

export interface CreateMailboxAssessmentServiceDeps {
  readonly mailboxService: MailboxService;
  readonly domainIntelligenceService: DomainIntelligenceService;
  readonly signalRepository: MailboxSignalRepository;
  readonly assessmentRepository: MailboxAssessmentRepository;
  readonly reputationService: ReputationService;
  readonly invalidationStore: AssessmentInvalidationStore;
}

// A forced refresh (POST /intelligence/refresh) is the one path a caller
// could hammer to force unlimited DNS/provider checks (Stage 7 spec
// section 20/21) — this is the guard against that. The read path
// (getAssessment) never needs a separate guard: it only ever refreshes
// when the latest snapshot has already gone stale, which by construction
// can't happen more often than ASSESSMENT_FRESH_WINDOW_MS.
const REFRESH_MIN_INTERVAL_MS = 60_000;

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 20;

function extractDomain(emailAddressCanonical: string): string {
  return emailAddressCanonical.slice(emailAddressCanonical.lastIndexOf("@") + 1);
}

export function createMailboxAssessmentService(deps: CreateMailboxAssessmentServiceDeps): MailboxAssessmentService {
  const { mailboxService, domainIntelligenceService, signalRepository, assessmentRepository, reputationService, invalidationStore } = deps;

  async function performRefresh(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot> {
    const mailbox = await mailboxService.getMailbox(tenantId, mailboxId);
    const connectionHealth = await mailboxService.getConnectionHealth(tenantId, mailboxId);
    const [domainAssessment, reputation] = await Promise.all([
      domainIntelligenceService.getAssessment(extractDomain(mailbox.emailAddressCanonical)),
      // Stage 10: computed as part of the same refresh cycle every other
      // signal source already goes through, never a separate synchronous
      // path triggered per delivery event (see delivery-events' own
      // ingestion service, which only marks this refresh stale).
      reputationService.assessReputation(tenantId, mailboxId),
    ]);

    const now = new Date();
    const signals = collectSignals({
      mailboxStatus: mailbox.status,
      connectionHealth,
      domainAssessment,
      observedAt: now,
    });
    await signalRepository.record(tenantId, mailboxId, signals);

    const health = evaluateHealth(signals, mailbox.enabled, now);
    const risk = evaluateRisk({ health, domainAssessed: true, reputation }, now);
    const eligibility = evaluateEligibility({ health, risk, mailboxEnabled: mailbox.enabled }, now);
    const capacity = recommendCapacity(eligibility.decision, now);

    const snapshot = await assessmentRepository.create({
      tenantId,
      mailboxId,
      snapshot: { health, risk, eligibility, capacity, domainAssessment, assessedAt: now },
    });
    // Cleared only after a full, successful refresh — a failed refresh
    // (thrown mid-way) leaves the marker set, so the next read still
    // knows to retry rather than silently serving stale evidence.
    await invalidationStore.clear(tenantId, mailboxId);
    return snapshot;
  }

  return {
    async getAssessment(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot> {
      const latest = await assessmentRepository.findLatest(tenantId, mailboxId);
      if (latest) {
        const freshness = computeFreshness("PROVIDER_CONNECTED", latest.assessedAt);
        // Stage 10 spec section 17: a new delivery event can mark this
        // mailbox stale even while it's still time-fresh — the next
        // decision-relevant read should pick up the new evidence rather
        // than waiting out the rest of the time-based freshness window.
        const stale = await invalidationStore.isStale(tenantId, mailboxId);
        if (freshness !== "EXPIRED" && !stale) {
          return latest;
        }
      }
      return performRefresh(tenantId, mailboxId);
    },

    async refreshAssessment(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot> {
      const latest = await assessmentRepository.findLatest(tenantId, mailboxId);
      if (latest) {
        const ageMs = Date.now() - latest.assessedAt.getTime();
        if (ageMs < REFRESH_MIN_INTERVAL_MS) {
          throw new RateLimitError("Mailbox intelligence was refreshed too recently — please try again shortly", {
            retryAfterSeconds: Math.ceil((REFRESH_MIN_INTERVAL_MS - ageMs) / 1000),
          });
        }
      }
      return performRefresh(tenantId, mailboxId);
    },

    async getHistory(tenantId: TenantId, mailboxId: MailboxId, limit = DEFAULT_HISTORY_LIMIT): Promise<AssessmentSnapshot[]> {
      const boundedLimit = Math.min(Math.max(1, limit), MAX_HISTORY_LIMIT);
      return assessmentRepository.listHistory(tenantId, mailboxId, boundedLimit);
    },
  };
}

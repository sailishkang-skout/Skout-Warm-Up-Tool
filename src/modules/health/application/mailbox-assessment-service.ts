import type { DomainIntelligenceService } from "../../domain-intelligence/application/domain-intelligence-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { recommendCapacity } from "../../policy/application/capacity-policy.js";
import { evaluateEligibility } from "../../policy/application/warmup-eligibility-policy.js";
import { evaluateRisk } from "../../risk/application/risk-policy.js";
import { RateLimitError } from "../../../shared/errors/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
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
  const { mailboxService, domainIntelligenceService, signalRepository, assessmentRepository } = deps;

  async function performRefresh(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot> {
    const mailbox = await mailboxService.getMailbox(tenantId, mailboxId);
    const connectionHealth = await mailboxService.getConnectionHealth(tenantId, mailboxId);
    const domainAssessment = await domainIntelligenceService.getAssessment(extractDomain(mailbox.emailAddressCanonical));

    const now = new Date();
    const signals = collectSignals({
      mailboxStatus: mailbox.status,
      connectionHealth,
      domainAssessment,
      observedAt: now,
    });
    await signalRepository.record(tenantId, mailboxId, signals);

    const health = evaluateHealth(signals, mailbox.enabled, now);
    const risk = evaluateRisk({ health, domainAssessed: true }, now);
    const eligibility = evaluateEligibility({ health, risk, mailboxEnabled: mailbox.enabled }, now);
    const capacity = recommendCapacity(eligibility.decision, now);

    return assessmentRepository.create({
      tenantId,
      mailboxId,
      snapshot: { health, risk, eligibility, capacity, domainAssessment, assessedAt: now },
    });
  }

  return {
    async getAssessment(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot> {
      const latest = await assessmentRepository.findLatest(tenantId, mailboxId);
      if (latest) {
        const freshness = computeFreshness("PROVIDER_CONNECTED", latest.assessedAt);
        if (freshness !== "EXPIRED") {
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

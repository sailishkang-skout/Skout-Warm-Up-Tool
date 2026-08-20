import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { MailboxStatus } from "../../mailbox/domain/mailbox.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import { incrementCounter, METRIC, setGauge } from "../../../shared/observability/index.js";
import { asWarmupNetworkRoutingDecisionId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { AppConfig } from "../../../shared/config/index.js";
import { remainingCapacity, utcDateString } from "../domain/warmup-network-status.js";
import type { WarmupNetworkRouteResult, WarmupNetworkSelection } from "../domain/warmup-network-routing.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import {
  classifyEmptyPoolFailure,
  evaluateWarmupMailboxEligibility,
  type WarmupNetworkEligibilityConfig,
} from "./warmup-network-eligibility.js";
import { applyRecentInteractionAvoidance, selectRankedWarmupMailbox } from "./warmup-network-ranking.js";
import type { WarmupNetworkCandidate, WarmupNetworkRepository } from "./warmup-network-repository.js";

export interface SelectWarmupMailboxInput {
  readonly customerTenantId: TenantId;
  readonly customerMailboxId: MailboxId;
  readonly requestKey: string;
  readonly now: Date;
}

export interface WarmupNetworkRouter {
  selectWarmupMailbox(input: SelectWarmupMailboxInput): Promise<WarmupNetworkRouteResult>;
  recordSendAccepted(networkMailboxId: WarmupNetworkMailbox["id"], at: Date): Promise<void>;
  recordAuthFailed(networkMailboxId: WarmupNetworkMailbox["id"], at: Date): Promise<void>;
}

function recordRoutingMetrics(
  result: WarmupNetworkRouteResult,
  context: { newlySelected: boolean; customerProvider?: string; remainingAfterSelect?: number },
): void {
  if (result.decision.outcome === "SELECTED" && result.selected) {
    incrementCounter(METRIC.warmupNetworkRouteSuccess);
    incrementCounter(METRIC.warmupNetworkMailboxSelected);
    incrementCounter(METRIC.warmupNetworkDomainSelected);
    if (context.customerProvider && result.selected.provider !== context.customerProvider) {
      incrementCounter(METRIC.warmupNetworkRouteProviderMismatch);
    }
    if (context.newlySelected && context.remainingAfterSelect !== undefined) {
      setGauge(METRIC.warmupNetworkCapacityRemaining, context.remainingAfterSelect);
    }
    return;
  }
  if (result.decision.outcome === "NO_ELIGIBLE_WARMUP_MAILBOX") {
    incrementCounter(METRIC.warmupNetworkRouteNoEligible);
    if (result.decision.reason === "CAPACITY_EXHAUSTED") {
      incrementCounter(METRIC.warmupNetworkRouteCapacityExhausted);
    }
    if (result.decision.eligibilitySummary.quarantined === true) {
      incrementCounter(METRIC.warmupNetworkRouteQuarantined);
    }
    return;
  }
  incrementCounter(METRIC.warmupNetworkRouteFailure);
}

export function createWarmupNetworkRouter(deps: {
  readonly database: Database;
  readonly mailboxService: MailboxService;
  readonly repository: WarmupNetworkRepository;
  readonly auditRecorder: AuditEventRecorder;
  readonly config: AppConfig["warmupNetwork"];
}): WarmupNetworkRouter {
  const eligibilityConfig: WarmupNetworkEligibilityConfig = {
    minHealthScore: deps.config.minHealthScore,
    requireSpf: deps.config.requireSpf,
    requireDkim: deps.config.requireDkim,
    requireDmarc: deps.config.requireDmarc,
  };

  async function toResultFromDecision(
    decision: WarmupNetworkRouteResult["decision"],
    failureClass: WarmupNetworkRouteResult["failureClass"] | undefined,
    client: DatabaseClient,
  ): Promise<WarmupNetworkRouteResult> {
    if (decision.outcome !== "SELECTED" || !decision.selectedNetworkMailboxId) {
      return { decision, ...(failureClass ? { failureClass } : {}) };
    }
    const mailbox = await deps.repository.getMailbox(decision.selectedNetworkMailboxId, client);
    if (!mailbox) {
      return { decision, failureClass: "PERMANENT" };
    }
    const selected: WarmupNetworkSelection = {
      networkMailboxId: mailbox.id,
      domainId: mailbox.domainId,
      mailboxId: mailbox.mailboxId,
      mailboxAddress: mailbox.mailboxAddress,
      provider: mailbox.provider,
    };
    return { decision, selected };
  }

  return {
    async selectWarmupMailbox(input: SelectWarmupMailboxInput): Promise<WarmupNetworkRouteResult> {
      incrementCounter(METRIC.warmupNetworkRouteAttempt);
      let newlySelected = false;
      let remainingAfterSelect: number | undefined;

      let customer;
      try {
        customer = await deps.mailboxService.getMailbox(input.customerTenantId, input.customerMailboxId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) {
          incrementCounter(METRIC.warmupNetworkRouteFailure);
          throw error;
        }
        customer = undefined;
      }
      const customerProvider = customer?.provider;

      let result: WarmupNetworkRouteResult;
      try {
        result = await deps.database.withTransaction(async (client) => {
          await deps.repository.lockRoutingRequestKey(client, input.requestKey);
          const existing = await deps.repository.findDecisionByRequestKey(client, input.requestKey);
          if (existing) {
            if (existing.outcome === "CUSTOMER_MAILBOX_DISCONNECTED") {
              return toResultFromDecision(existing, "PERMANENT", client);
            }
            if (existing.outcome === "NO_ELIGIBLE_WARMUP_MAILBOX") {
              const failureClass = existing.eligibilitySummary.failureClass === "TEMPORARY" ? "TEMPORARY" : "PERMANENT";
              return toResultFromDecision(existing, failureClass, client);
            }
            return toResultFromDecision(existing, undefined, client);
          }

          if (!customer) {
            return {
              decision: {
                id: asWarmupNetworkRoutingDecisionId("00000000-0000-0000-0000-000000000000"),
                routingRequestKey: input.requestKey,
                customerTenantId: input.customerTenantId,
                customerMailboxId: input.customerMailboxId,
                outcome: "CUSTOMER_MAILBOX_DISCONNECTED" as const,
                reason: "CUSTOMER_MAILBOX_MISSING",
                eligibilitySummary: { customerStatus: "MISSING" },
                createdAt: input.now,
              },
              failureClass: "PERMANENT" as const,
            };
          }

          if (customer.status !== "CONNECTED" || !customer.enabled) {
            const decision = await deps.repository.insertDecision(client, {
              routingRequestKey: input.requestKey,
              customerTenantId: input.customerTenantId,
              customerMailboxId: input.customerMailboxId,
              outcome: "CUSTOMER_MAILBOX_DISCONNECTED",
              reason: !customer.enabled ? "CUSTOMER_MAILBOX_DISABLED" : "CUSTOMER_MAILBOX_DISCONNECTED",
              eligibilitySummary: {
                customerStatus: customer.status,
                customerEnabled: customer.enabled,
              },
            });
            return { decision, failureClass: "PERMANENT" as const };
          }

          const candidates = await deps.repository.lockCandidatesForUpdate(client);
          const evaluated = candidates
            .filter((candidate) => candidate.mailbox.mailboxId !== input.customerMailboxId)
            .map((candidate) => {
              const extraReasons: string[] = [];
              if (candidate.networkStatus !== "ACTIVE" || candidate.poolStatus !== "ACTIVE") {
                extraReasons.push("STATUS_NOT_ACTIVE");
              }
              const evaluation = evaluateWarmupMailboxEligibility(
                candidate.mailbox,
                candidate.domain,
                input.now,
                eligibilityConfig,
                { status: candidate.linkedMailboxStatus as MailboxStatus, enabled: candidate.linkedMailboxEnabled },
              );
              const reasons = extraReasons.length > 0 ? ["STATUS_NOT_ACTIVE", ...evaluation.reasons] : [...evaluation.reasons];
              const eligible = extraReasons.length === 0 && evaluation.eligible;
              return { candidate, eligible, reasons };
            });

          const eligible = evaluated.filter((entry) => entry.eligible).map((entry) => entry.candidate);
          const since = new Date(input.now.getTime() - deps.config.recentInteractionWindowMs);
          const recentIds = new Set(
            (await deps.repository.listRecentSelectedMailboxIds(client, input.customerMailboxId, since)).map((id) => id as string),
          );
          const avoided = applyRecentInteractionAvoidance(
            eligible.map((candidate) => ({
              ...candidate,
              id: candidate.mailbox.id,
              provider: candidate.mailbox.provider,
              healthScore: candidate.mailbox.healthScore,
              remainingCapacity: remainingCapacity(
                candidate.mailbox.dailyCapacity,
                candidate.mailbox.usageDate,
                candidate.mailbox.usageCount,
                input.now,
              ),
            })),
            recentIds,
          );

          const selectedCandidate = selectRankedWarmupMailbox(avoided, customer.provider);
          if (!selectedCandidate) {
            const { reason, failureClass } = classifyEmptyPoolFailure(
              evaluated.map((entry) => ({ eligible: entry.eligible, reasons: entry.reasons as never })),
            );
            const quarantined = evaluated.some(
              (entry) => entry.candidate.mailbox.status === "QUARANTINED" || entry.candidate.domain.status === "QUARANTINED",
            );
            const decision = await deps.repository.insertDecision(client, {
              routingRequestKey: input.requestKey,
              customerTenantId: input.customerTenantId,
              customerMailboxId: input.customerMailboxId,
              outcome: "NO_ELIGIBLE_WARMUP_MAILBOX",
              reason,
              eligibilitySummary: {
                candidateCount: candidates.length,
                eligibleCount: 0,
                failureClass,
                quarantined,
              },
            });
            return { decision, failureClass };
          }

          const picked = eligible.find((candidate) => candidate.mailbox.id === selectedCandidate.id);
          if (!picked) {
            const decision = await deps.repository.insertDecision(client, {
              routingRequestKey: input.requestKey,
              customerTenantId: input.customerTenantId,
              customerMailboxId: input.customerMailboxId,
              outcome: "NO_ELIGIBLE_WARMUP_MAILBOX",
              reason: "NO_ELIGIBLE_WARMUP_MAILBOX",
              eligibilitySummary: { candidateCount: candidates.length, eligibleCount: 0, failureClass: "PERMANENT" },
            });
            return { decision, failureClass: "PERMANENT" as const };
          }

          const reserved = await deps.repository.reserveUsage(
            client,
            picked.mailbox.id,
            picked.domain.id,
            utcDateString(input.now),
          );
          if (!reserved) {
            const decision = await deps.repository.insertDecision(client, {
              routingRequestKey: input.requestKey,
              customerTenantId: input.customerTenantId,
              customerMailboxId: input.customerMailboxId,
              outcome: "NO_ELIGIBLE_WARMUP_MAILBOX",
              reason: "CAPACITY_EXHAUSTED",
              eligibilitySummary: {
                candidateCount: candidates.length,
                eligibleCount: eligible.length,
                failureClass: "TEMPORARY",
              },
            });
            return { decision, failureClass: "TEMPORARY" as const };
          }

          remainingAfterSelect = Math.max(
            0,
            remainingCapacity(
              picked.mailbox.dailyCapacity,
              picked.mailbox.usageDate,
              picked.mailbox.usageCount,
              input.now,
            ) - 1,
          );

          const decision = await deps.repository.insertDecision(client, {
            routingRequestKey: input.requestKey,
            customerTenantId: input.customerTenantId,
            customerMailboxId: input.customerMailboxId,
            selectedNetworkMailboxId: picked.mailbox.id,
            selectedDomainId: picked.domain.id,
            outcome: "SELECTED",
            reason: "SELECTED",
            eligibilitySummary: {
              candidateCount: candidates.length,
              eligibleCount: eligible.length,
              avoidedRecent: recentIds.size > 0,
              selectedProvider: picked.mailbox.provider,
              customerProvider: customer.provider,
            },
          });

          const selected: WarmupNetworkSelection = {
            networkMailboxId: picked.mailbox.id,
            domainId: picked.domain.id,
            mailboxId: picked.mailbox.mailboxId,
            mailboxAddress: picked.mailbox.mailboxAddress,
            provider: picked.mailbox.provider,
          };
          newlySelected = true;
          return { decision, selected };
        });
      } catch (error) {
        incrementCounter(METRIC.warmupNetworkRouteFailure);
        throw error;
      }

      recordRoutingMetrics(result, {
        newlySelected,
        ...(customerProvider ? { customerProvider } : {}),
        ...(remainingAfterSelect !== undefined ? { remainingAfterSelect } : {}),
      });

      if (newlySelected && result.selected) {
        await deps.auditRecorder.record({
          tenantId: input.customerTenantId,
          eventType: "WARMUP_NETWORK_ROUTED",
          actorType: "system",
          metadata: {
            routingDecisionId: result.decision.id,
            customerMailboxId: input.customerMailboxId,
            selectedNetworkMailboxId: result.selected.networkMailboxId,
            selectedDomainId: result.selected.domainId,
            outcome: result.decision.outcome,
            reason: result.decision.reason,
          },
        });
      }

      return result;
    },

    recordSendAccepted(networkMailboxId, at) {
      return deps.repository.recordSuccessfulInteraction(networkMailboxId, at);
    },

    recordAuthFailed(networkMailboxId, at) {
      return deps.repository.markCredentialUnavailable(networkMailboxId, at);
    },
  };
}

export type { WarmupNetworkCandidate };

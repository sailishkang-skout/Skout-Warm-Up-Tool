import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import { NotFoundError, TransientError } from "../../../shared/errors/index.js";
import type { Logger } from "../../../shared/logger/index.js";
import type { ConversationId, MessageId, TenantId } from "../../../shared/types/index.js";
import type { ConversationService } from "./conversation-service.js";
import type { ConversationPolicyRepository } from "./conversation-policy-repository.js";
import { evaluatePolicy } from "../domain/policy-evaluation.js";
import type { ConversationPolicySignal } from "../domain/policy-result.js";
import type { DomainFactType } from "../domain/domain-facts.js";
import { type PolicySignalType } from "../domain/policy-signal-taxonomy.js";

const LEASE_DURATION_MS = 60_000;
const RECLAIM_LIMIT = 50;
const CLAIM_BATCH = 10;
const MAX_ATTEMPTS = 5;

export interface PolicyEvaluationTickResult {
  readonly reclaimedLeases: number;
  readonly enqueued: number;
  readonly processed: number;
  readonly evaluated: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ConversationPolicyWorker {
  runTick(workerId: string): Promise<PolicyEvaluationTickResult>;
}

export interface ConversationPolicyQueryService {
  listPolicySignals(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]>;
  listMessagePolicySignals(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]>;
}

export interface CreateConversationPolicyWorkerDeps {
  readonly conversationService: ConversationService;
  readonly policyRepository: ConversationPolicyRepository;
  readonly policyVersion: string;
  readonly taxonomyVersion: string;
  readonly auditRecorder: AuditEventRecorder;
  readonly logger: Logger;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "Policy evaluation failed";
}

function isRetryable(error: unknown): boolean {
  return error instanceof TransientError;
}

export function createConversationPolicyWorker(
  deps: CreateConversationPolicyWorkerDeps,
): ConversationPolicyWorker & ConversationPolicyQueryService {
  const { conversationService, policyRepository, policyVersion, taxonomyVersion, auditRecorder, logger } = deps;

  return {
    async runTick(workerId: string): Promise<PolicyEvaluationTickResult> {
      const enqueued = await policyRepository.enqueuePendingFromFacts(policyVersion, taxonomyVersion);
      const reclaimedLeases = await policyRepository.reclaimExpiredLeases(new Date(), RECLAIM_LIMIT);

      let processed = 0;
      let evaluated = 0;
      let failed = 0;
      let skipped = 0;

      for (let i = 0; i < CLAIM_BATCH; i += 1) {
        const claimed = await policyRepository.claimNext(workerId, LEASE_DURATION_MS);
        if (!claimed) {
          break;
        }
        processed += 1;
        try {
          const result = evaluatePolicy(claimed.factTypes, {
            policyVersion: claimed.policyVersion,
            taxonomyVersion: claimed.taxonomyVersion,
          });
          const sourceFactIds: Partial<Record<DomainFactType, string>> = {};
          if (claimed.sourceMessageId) {
            const facts = await policyRepository.listDomainFactsForMessage(claimed.tenantId, claimed.sourceMessageId);
            for (const fact of facts) {
              sourceFactIds[fact.factType] ??= fact.id;
            }
          }
          const created = await policyRepository.completeEvaluated(claimed.id, workerId, {
            signals: result.signals,
            sourceFactIds,
          });
          if (!created) {
            skipped += 1;
            continue;
          }

          await auditRecorder.record({
            tenantId: claimed.tenantId,
            eventType: "POLICY_EVALUATED",
            actorType: "system",
            metadata: {
              conversationId: claimed.conversationId,
              messageId: claimed.sourceMessageId,
              evaluationId: claimed.id,
              policyVersion: claimed.policyVersion,
              taxonomyVersion: claimed.taxonomyVersion,
              signalCount: created.length,
            },
          });
          for (const signal of created) {
            await auditRecorder.record({
              tenantId: claimed.tenantId,
              eventType: "POLICY_SIGNAL_CREATED",
              actorType: "system",
              metadata: {
                conversationId: signal.conversationId,
                messageId: signal.sourceMessageId,
                evaluationId: signal.policyEvaluationId,
                signalId: signal.id,
                signal: signal.signal,
                priority: signal.priority,
                policyVersion: signal.policyVersion,
                sourceFactId: signal.sourceFactId,
              },
            });
          }
          evaluated += 1;
        } catch (error) {
          const attemptCount = claimed.attemptCount + 1;
          const retryable = isRetryable(error) && attemptCount < MAX_ATTEMPTS;
          await policyRepository.completeFailure(claimed.id, workerId, safeError(error), {
            status: retryable ? "PENDING" : "FAILED",
            nextAttemptAt: new Date(Date.now() + (retryable ? 1_000 * 2 ** attemptCount : 0)),
            attemptCount,
          });
          if (retryable) {
            logger.warn({ evaluationId: claimed.id }, safeError(error));
          } else {
            failed += 1;
            logger.error({ err: error, evaluationId: claimed.id }, "Policy evaluation failed");
          }
        }
      }

      return { reclaimedLeases, enqueued, processed, evaluated, failed, skipped };
    },

    async listPolicySignals(tenantId, conversationId, limit, offset, signal) {
      await conversationService.getConversation(tenantId, conversationId);
      return policyRepository.listSignalsByConversation(tenantId, conversationId, limit, offset, signal);
    },

    async listMessagePolicySignals(tenantId, conversationId, messageId, limit, offset, signal) {
      await conversationService.getConversation(tenantId, conversationId);
      const belongs = await policyRepository.messageBelongsToConversation(tenantId, conversationId, messageId);
      if (!belongs) {
        throw new NotFoundError("Message not found");
      }
      return policyRepository.listSignalsByMessage(tenantId, conversationId, messageId, limit, offset, signal);
    },
  };
}

import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import {
  ConfigurationError,
  NotFoundError,
  PermanentError,
  ProviderError,
  TransientError,
  ValidationError,
} from "../../../shared/errors/index.js";
import type { Logger } from "../../../shared/logger/index.js";
import type { ConversationId, MessageId, TenantId } from "../../../shared/types/index.js";
import {
  CLASSIFICATION_RECENT_BODY_CHARS,
  CLASSIFICATION_RECENT_MESSAGE_LIMIT,
  toClassificationMessageView,
} from "./classification-context.js";
import { computeClassificationInputHash } from "./classification-input-hash.js";
import type { ClassificationRepository } from "./classification-repository.js";
import type { ConversationClassifier } from "./conversation-classifier.js";
import type { ConversationMessageRepository } from "./conversation-message-repository.js";
import type { ConversationService } from "./conversation-service.js";
import { decideClassificationRetry, decideMalformedClassificationRetry } from "../domain/classification-retry.js";
import type { ConversationClassificationFacts } from "../domain/conversation-facts.js";
import { projectConversationFacts } from "../domain/conversation-facts.js";
import type { ClassifierType, MessageClassification, ValidatedClassification } from "../domain/classification.js";
import { CLASSIFICATION_TAXONOMY_VERSION, type ClassificationLabel } from "../domain/classification-taxonomy.js";
import { domainFactsFromLabels, type ConversationDomainFact, type DomainFactType } from "../domain/domain-facts.js";
import type { ConversationMessage } from "../domain/conversation-message.js";

const LEASE_DURATION_MS = 60_000;
const RECLAIM_LIMIT = 50;
const CLAIM_BATCH = 10;
const DETERMINISTIC_MODEL = "deterministic";

const UNKNOWN_RESULT: ValidatedClassification = {
  labels: ["UNKNOWN"],
  primaryLabel: "UNKNOWN",
  confidence: 0,
  confidenceBand: "LOW",
  reason: "Malformed classifier output after retry; not treated as a positive or negative fact",
  classifierType: "AI",
};

export interface ClassificationWorkerTickResult {
  readonly reclaimedLeases: number;
  readonly processed: number;
  readonly classified: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface ClassificationWorker {
  runTick(workerId: string): Promise<ClassificationWorkerTickResult>;
}

export interface ClassificationQueryService {
  listClassifications(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    label: ClassificationLabel | undefined,
  ): Promise<readonly MessageClassification[]>;
  getMessageClassification(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<MessageClassification>;
  getConversationFacts(tenantId: TenantId, conversationId: ConversationId): Promise<ConversationClassificationFacts | undefined>;
  listDomainFacts(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    factType: DomainFactType | undefined,
  ): Promise<readonly ConversationDomainFact[]>;
}

export interface CreateClassificationWorkerDeps {
  readonly conversationService: ConversationService;
  readonly messageRepository: ConversationMessageRepository;
  readonly classificationRepository: ClassificationRepository;
  readonly classifier: ConversationClassifier | undefined;
  readonly classifierVersion: string;
  readonly taxonomyVersion?: string;
  readonly modelName: string;
  readonly maxInputChars: number;
  readonly auditRecorder: AuditEventRecorder;
  readonly logger: Logger;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TransientError) {
    return true;
  }
  if (error instanceof ProviderError) {
    return error.retryable;
  }
  return false;
}

function isMalformedClassifierError(error: unknown): boolean {
  if (error instanceof ValidationError) {
    return true;
  }
  if (error instanceof PermanentError) {
    return /classifier|invalid json|non-object payload|unknown label|invalid confidence|invalid reason|invalid evidence|invalid primary/i.test(
      error.message,
    );
  }
  return false;
}

function isConfigFailure(error: unknown): boolean {
  if (error instanceof ConfigurationError) {
    return true;
  }
  return error instanceof PermanentError && /authentication failed/i.test(error.message);
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "Classification failed";
}

function classifierTypeOf(result: ValidatedClassification): ClassifierType {
  return result.classifierType ?? "AI";
}

export function createClassificationWorker(deps: CreateClassificationWorkerDeps): ClassificationWorker & ClassificationQueryService {
  const {
    conversationService,
    messageRepository,
    classificationRepository,
    classifier,
    classifierVersion,
    taxonomyVersion = CLASSIFICATION_TAXONOMY_VERSION,
    modelName,
    maxInputChars,
    auditRecorder,
    logger,
  } = deps;

  async function recentBefore(current: ConversationMessage): Promise<ConversationMessage[]> {
    const all = await messageRepository.listByConversation(current.tenantId, current.conversationId, 50, 0);
    return all
      .filter((message) => message.id !== current.id && message.sentAt.getTime() <= current.sentAt.getTime())
      .slice(-CLASSIFICATION_RECENT_MESSAGE_LIMIT);
  }

  async function persistSuccess(
    claimed: MessageClassification,
    workerId: string,
    current: ConversationMessage,
    result: ValidatedClassification,
    inputHash: string,
  ): Promise<"classified" | "skipped"> {
    const saved = await classificationRepository.completeClassified(claimed.id, workerId, {
      labels: result.labels,
      primaryLabel: result.primaryLabel,
      confidence: result.confidence,
      confidenceBand: result.confidenceBand,
      reason: result.reason,
      model: classifierTypeOf(result) === "DETERMINISTIC" ? DETERMINISTIC_MODEL : modelName,
      inputHash,
      classifierType: classifierTypeOf(result),
      evidence: result.evidence ?? [],
    });
    if (!saved) {
      return "skipped";
    }

    const classifiedRows = await classificationRepository.listClassifiedByConversation(claimed.tenantId, claimed.conversationId);
    const union = classifiedRows.flatMap((row) => row.labels);
    const needsHumanReview = result.confidenceBand === "LOW" || result.labels.includes("NEEDS_HUMAN_REVIEW");
    const projection = projectConversationFacts({
      labels: union,
      primaryLabel: result.primaryLabel,
      needsHumanReview,
    });
    const facts = await classificationRepository.upsertFacts({
      tenantId: claimed.tenantId,
      conversationId: claimed.conversationId,
      labels: projection.labels,
      ...(projection.primaryLabel ? { primaryLabel: projection.primaryLabel } : {}),
      needsHumanReview: projection.needsHumanReview,
      lastClassifiedMessageId: current.id,
      lastClassifiedAt: new Date(),
    });

    const domainTypes: DomainFactType[] = [...domainFactsFromLabels(result.labels)];
    if (current.direction === "INBOUND" && !domainTypes.includes("MESSAGE_RECEIVED")) {
      domainTypes.unshift("MESSAGE_RECEIVED");
    }
    const createdFacts = await classificationRepository.insertDomainFacts({
      tenantId: claimed.tenantId,
      conversationId: claimed.conversationId,
      messageId: claimed.messageId,
      classificationId: saved.id,
      factTypes: domainTypes,
      classifierVersion,
      taxonomyVersion,
      evidence: result.evidence ?? [],
    });

    await auditRecorder.record({
      tenantId: claimed.tenantId,
      eventType: "MESSAGE_CLASSIFIED",
      actorType: "system",
      metadata: {
        conversationId: claimed.conversationId,
        messageId: claimed.messageId,
        classificationId: saved.id,
        labels: saved.labels,
        primaryLabel: saved.primaryLabel,
        confidence: saved.confidence,
        confidenceBand: saved.confidenceBand,
        classifierVersion,
        taxonomyVersion,
        classifierType: saved.classifierType,
      },
    });
    if (facts.labelsChanged) {
      await auditRecorder.record({
        tenantId: claimed.tenantId,
        eventType: "CONVERSATION_CLASSIFIED",
        actorType: "system",
        metadata: {
          conversationId: claimed.conversationId,
          labels: facts.facts.labels,
          primaryLabel: facts.facts.primaryLabel,
          needsHumanReview: facts.facts.needsHumanReview,
          classifierVersion,
          taxonomyVersion,
        },
      });
    }
    for (const fact of createdFacts) {
      await auditRecorder.record({
        tenantId: claimed.tenantId,
        eventType: "DOMAIN_FACT_CREATED",
        actorType: "system",
        metadata: {
          conversationId: fact.conversationId,
          messageId: fact.messageId,
          classificationId: saved.id,
          factType: fact.factType,
          classifierVersion: fact.classifierVersion,
          taxonomyVersion: fact.taxonomyVersion,
        },
      });
    }
    return "classified";
  }

  return {
    async runTick(workerId: string): Promise<ClassificationWorkerTickResult> {
      const reclaimedLeases = await classificationRepository.reclaimExpiredLeases(new Date(), RECLAIM_LIMIT);
      if (!classifier) {
        return { reclaimedLeases, processed: 0, classified: 0, failed: 0, skipped: 0 };
      }

      let processed = 0;
      let classified = 0;
      let failed = 0;
      let skipped = 0;

      for (let i = 0; i < CLAIM_BATCH; i += 1) {
        const claimed = await classificationRepository.claimNext(workerId, LEASE_DURATION_MS);
        if (!claimed) {
          break;
        }
        processed += 1;
        try {
          const messages = await messageRepository.listByConversation(claimed.tenantId, claimed.conversationId, 100, 0);
          const current = messages.find((message) => message.id === claimed.messageId);
          if (!current) {
            await classificationRepository.completeFailure(claimed.id, workerId, "Message was not found for classification.", {
              status: "FAILED",
              nextAttemptAt: new Date(),
              attemptCount: claimed.attemptCount + 1,
            });
            await auditRecorder.record({
              tenantId: claimed.tenantId,
              eventType: "CLASSIFICATION_FAILED",
              actorType: "system",
              metadata: {
                conversationId: claimed.conversationId,
                messageId: claimed.messageId,
                classificationId: claimed.id,
                classifierVersion,
                taxonomyVersion,
                status: "FAILED",
              },
            });
            failed += 1;
            continue;
          }

          const recent = await recentBefore(current);
          const inputHash = computeClassificationInputHash({
            classifierVersion,
            taxonomyVersion,
            current: toClassificationMessageView(current, maxInputChars),
            recent: recent.map((message) => toClassificationMessageView(message, CLASSIFICATION_RECENT_BODY_CHARS)),
          });

          const result = await classifier.classify(current, recent);
          const outcome = await persistSuccess(claimed, workerId, current, result, inputHash);
          if (outcome === "skipped") {
            skipped += 1;
          } else {
            classified += 1;
          }
        } catch (error) {
          const attemptCount = claimed.attemptCount + 1;
          if (isMalformedClassifierError(error)) {
            const retry = decideMalformedClassificationRetry(attemptCount);
            if (retry.shouldRetry) {
              await classificationRepository.completeFailure(claimed.id, workerId, safeError(error), {
                status: "PENDING",
                nextAttemptAt: new Date(Date.now() + (retry.delayMs ?? 0)),
                attemptCount,
              });
              logger.warn({ classificationId: claimed.id }, safeError(error));
              continue;
            }
            const messages = await messageRepository.listByConversation(claimed.tenantId, claimed.conversationId, 100, 0);
            const current = messages.find((message) => message.id === claimed.messageId);
            if (current) {
              const inputHash = computeClassificationInputHash({
                classifierVersion,
                taxonomyVersion,
                current: toClassificationMessageView(current, maxInputChars),
                recent: [],
              });
              const outcome = await persistSuccess(claimed, workerId, current, UNKNOWN_RESULT, inputHash);
              if (outcome === "classified") {
                classified += 1;
              } else {
                skipped += 1;
              }
              continue;
            }
          }

          const retryable = isRetryable(error) && !isConfigFailure(error);
          const retry = decideClassificationRetry(retryable, attemptCount);
          await classificationRepository.completeFailure(claimed.id, workerId, safeError(error), {
            status: retry.shouldRetry ? "PENDING" : "FAILED",
            nextAttemptAt: new Date(Date.now() + (retry.delayMs ?? 0)),
            attemptCount,
          });
          if (retry.shouldRetry) {
            logger.warn({ classificationId: claimed.id }, safeError(error));
          } else {
            failed += 1;
            logger.error({ err: error, classificationId: claimed.id }, "Classification job failed");
            await auditRecorder.record({
              tenantId: claimed.tenantId,
              eventType: "CLASSIFICATION_FAILED",
              actorType: "system",
              metadata: {
                conversationId: claimed.conversationId,
                messageId: claimed.messageId,
                classificationId: claimed.id,
                classifierVersion,
                taxonomyVersion,
                status: "FAILED",
              },
            });
          }
        }
      }

      return { reclaimedLeases, processed, classified, failed, skipped };
    },

    async listClassifications(tenantId, conversationId, limit, offset, label) {
      await conversationService.getConversation(tenantId, conversationId);
      return classificationRepository.listByConversation(tenantId, conversationId, limit, offset, label);
    },

    async getMessageClassification(tenantId, conversationId, messageId) {
      await conversationService.getConversation(tenantId, conversationId);
      const found = await classificationRepository.findByMessage(
        tenantId,
        conversationId,
        messageId,
        classifierVersion,
        taxonomyVersion,
      );
      if (!found) {
        throw new NotFoundError("Classification not found");
      }
      return found;
    },

    async getConversationFacts(tenantId, conversationId) {
      await conversationService.getConversation(tenantId, conversationId);
      return classificationRepository.getFacts(tenantId, conversationId);
    },

    async listDomainFacts(tenantId, conversationId, limit, offset, factType) {
      await conversationService.getConversation(tenantId, conversationId);
      return classificationRepository.listDomainFacts(tenantId, conversationId, limit, offset, factType);
    },
  };
}

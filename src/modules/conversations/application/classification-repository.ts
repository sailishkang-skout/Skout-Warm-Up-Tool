import type { DatabaseClient } from "../../../shared/db/index.js";
import type { ConversationId, MessageClassificationId, MessageId, TenantId } from "../../../shared/types/index.js";
import type { ConfidenceBand } from "../domain/classification-confidence.js";
import type { ClassificationStatus, ClassifierType, ClassificationEvidence, MessageClassification } from "../domain/classification.js";
import type { ClassificationLabel } from "../domain/classification-taxonomy.js";
import type { ConversationClassificationFacts } from "../domain/conversation-facts.js";
import type { ConversationDomainFact, DomainFactType } from "../domain/domain-facts.js";

export interface EnqueueClassificationInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly classifierVersion: string;
  readonly taxonomyVersion: string;
}

export interface CompleteClassificationInput {
  readonly labels: readonly ClassificationLabel[];
  readonly primaryLabel: ClassificationLabel;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly reason: string;
  readonly model: string;
  readonly inputHash: string;
  readonly classifierType: ClassifierType;
  readonly evidence: readonly ClassificationEvidence[];
}

export interface UpsertConversationFactsInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly labels: readonly string[];
  readonly primaryLabel?: string;
  readonly needsHumanReview: boolean;
  readonly lastClassifiedMessageId: MessageId;
  readonly lastClassifiedAt: Date;
}

export interface InsertDomainFactsInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly classificationId: MessageClassificationId;
  readonly factTypes: readonly DomainFactType[];
  readonly classifierVersion: string;
  readonly taxonomyVersion: string;
  readonly evidence: readonly ClassificationEvidence[];
}

export interface ClassificationRepository {
  enqueueOnClient(client: DatabaseClient, input: EnqueueClassificationInput): Promise<void>;
  claimNext(leaseOwner: string, leaseDurationMs: number): Promise<MessageClassification | undefined>;
  reclaimExpiredLeases(now: Date, limit: number): Promise<number>;
  completeClassified(
    id: MessageClassificationId,
    leaseOwner: string,
    input: CompleteClassificationInput,
  ): Promise<MessageClassification | undefined>;
  completeFailure(
    id: MessageClassificationId,
    leaseOwner: string,
    lastErrorSafe: string,
    next: { status: Extract<ClassificationStatus, "PENDING" | "FAILED">; nextAttemptAt: Date; attemptCount: number },
  ): Promise<void>;
  findByMessage(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
    classifierVersion: string,
    taxonomyVersion: string,
  ): Promise<MessageClassification | undefined>;
  listByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    label: ClassificationLabel | undefined,
  ): Promise<readonly MessageClassification[]>;
  listClassifiedByConversation(tenantId: TenantId, conversationId: ConversationId): Promise<readonly MessageClassification[]>;
  upsertFacts(input: UpsertConversationFactsInput): Promise<{ facts: ConversationClassificationFacts; labelsChanged: boolean }>;
  getFacts(tenantId: TenantId, conversationId: ConversationId): Promise<ConversationClassificationFacts | undefined>;
  insertDomainFacts(input: InsertDomainFactsInput): Promise<readonly ConversationDomainFact[]>;
  listDomainFacts(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    factType: DomainFactType | undefined,
  ): Promise<readonly ConversationDomainFact[]>;
}

import type { ConversationId, MessageClassificationId, MessageId, TenantId } from "../../../shared/types/index.js";
import type { ConfidenceBand } from "./classification-confidence.js";
import type { ClassificationLabel } from "./classification-taxonomy.js";

export const CLASSIFICATION_STATUSES = ["PENDING", "PROCESSING", "CLASSIFIED", "FAILED"] as const;
export type ClassificationStatus = (typeof CLASSIFICATION_STATUSES)[number];

export const CLASSIFIER_TYPES = ["DETERMINISTIC", "AI", "HYBRID"] as const;
export type ClassifierType = (typeof CLASSIFIER_TYPES)[number];

export interface ClassificationEvidence {
  readonly ruleId: string;
  readonly snippet: string;
}

export interface MessageClassification {
  readonly id: MessageClassificationId;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly classifierVersion: string;
  readonly taxonomyVersion: string;
  readonly classifierType?: ClassifierType;
  readonly labels: readonly ClassificationLabel[];
  readonly primaryLabel?: ClassificationLabel;
  readonly confidence?: number;
  readonly confidenceBand?: ConfidenceBand;
  readonly reason?: string;
  readonly evidence: readonly ClassificationEvidence[];
  readonly model?: string;
  readonly inputHash?: string;
  readonly status: ClassificationStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastErrorSafe?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ValidatedClassification {
  readonly labels: readonly ClassificationLabel[];
  readonly primaryLabel: ClassificationLabel;
  readonly confidence: number;
  readonly confidenceBand: ConfidenceBand;
  readonly reason: string;
  readonly evidence?: readonly ClassificationEvidence[];
  readonly classifierType?: ClassifierType;
}

export const CLASSIFICATION_STATUSES_CLAIMABLE: ReadonlySet<ClassificationStatus> = new Set(["PENDING", "PROCESSING"]);

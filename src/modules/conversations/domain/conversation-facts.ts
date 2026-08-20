import type { ConversationId, MessageId, TenantId } from "../../../shared/types/index.js";
import type { ClassificationLabel, ConversationFactLabel } from "./classification-taxonomy.js";
import { isConversationFactLabel } from "./classification-taxonomy.js";

export interface ConversationClassificationFacts {
  readonly conversationId: ConversationId;
  readonly tenantId: TenantId;
  readonly labels: readonly ConversationFactLabel[];
  readonly primaryLabel?: ConversationFactLabel;
  readonly needsHumanReview: boolean;
  readonly lastClassifiedMessageId?: MessageId;
  readonly lastClassifiedAt: Date;
  readonly updatedAt: Date;
}

export function projectConversationFacts(input: {
  readonly labels: readonly ClassificationLabel[];
  readonly primaryLabel: ClassificationLabel;
  readonly needsHumanReview: boolean;
}): {
  readonly labels: readonly ConversationFactLabel[];
  readonly primaryLabel?: ConversationFactLabel;
  readonly needsHumanReview: boolean;
} {
  const unique = [...new Set(input.labels.filter(isConversationFactLabel))];
  unique.sort();
  return {
    labels: unique,
    ...(isConversationFactLabel(input.primaryLabel) ? { primaryLabel: input.primaryLabel } : {}),
    needsHumanReview: input.needsHumanReview || unique.includes("NEEDS_HUMAN_REVIEW"),
  };
}

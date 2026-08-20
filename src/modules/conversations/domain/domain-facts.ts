import type { CanonicalClassificationLabel } from "./classification-taxonomy.js";
import { toCanonicalLabels } from "./classification-taxonomy.js";
import type { ClassificationEvidence } from "./classification.js";
import type { ConversationId, MessageClassificationId, MessageId, TenantId } from "../../../shared/types/index.js";

/**
 * Provider-neutral facts about what happened. These are not actions —
 * STOP_SEQUENCE / CREATE_CRM_TASK / ADD_SUPPRESSION / SEND_FOLLOWUP /
 * BOOK_MEETING are intentionally absent.
 */
export const DOMAIN_FACT_TYPES = [
  "MESSAGE_RECEIVED",
  "POSITIVE_INTEREST",
  "NEGATIVE_INTEREST",
  "UNSUBSCRIBE",
  "OOO",
  "WRONG_PERSON",
  "REFERRAL",
  "QUESTION",
  "MEETING_REQUEST",
  "SPAM",
] as const;

export type DomainFactType = (typeof DOMAIN_FACT_TYPES)[number];

const DOMAIN_FACT_SET: ReadonlySet<string> = new Set(DOMAIN_FACT_TYPES);

export function isDomainFactType(value: string): value is DomainFactType {
  return DOMAIN_FACT_SET.has(value);
}

export const ACTION_FACT_TYPES = [
  "STOP_SEQUENCE",
  "CREATE_CRM_TASK",
  "ADD_SUPPRESSION",
  "SEND_FOLLOWUP",
  "BOOK_MEETING",
] as const;

const LABEL_TO_DOMAIN_FACT: Partial<Record<CanonicalClassificationLabel, DomainFactType>> = {
  POSITIVE_INTEREST: "POSITIVE_INTEREST",
  NEGATIVE: "NEGATIVE_INTEREST",
  UNSUBSCRIBE: "UNSUBSCRIBE",
  OOO: "OOO",
  WRONG_PERSON: "WRONG_PERSON",
  REFERRAL: "REFERRAL",
  QUESTION: "QUESTION",
  MEETING_REQUEST: "MEETING_REQUEST",
  SPAM: "SPAM",
};

export interface ConversationDomainFact {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly classificationId?: MessageClassificationId;
  readonly factType: DomainFactType;
  readonly classifierVersion: string;
  readonly taxonomyVersion: string;
  readonly evidence: readonly ClassificationEvidence[];
  readonly createdAt: Date;
}

export function domainFactsFromLabels(labels: readonly string[]): DomainFactType[] {
  const facts: DomainFactType[] = [];
  for (const label of toCanonicalLabels(labels)) {
    const fact = LABEL_TO_DOMAIN_FACT[label];
    if (fact && !facts.includes(fact)) {
      facts.push(fact);
    }
  }
  return facts;
}

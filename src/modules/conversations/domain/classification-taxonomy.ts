/**
 * Stage 13B labels remain accepted so historical rows and existing tests
 * stay valid. Stage 13C canonical labels are the ones new classifiers emit.
 * Action labels (STOP_SEQUENCE, CREATE_CRM_TASK, …) are never valid.
 */
export const CLASSIFICATION_TAXONOMY_VERSION = "classification-taxonomy/v1";

export const CANONICAL_CLASSIFICATION_LABELS = [
  "POSITIVE_INTEREST",
  "NEGATIVE",
  "UNSUBSCRIBE",
  "OOO",
  "WRONG_PERSON",
  "REFERRAL",
  "QUESTION",
  "MEETING_REQUEST",
  "NEUTRAL",
  "SPAM",
  "UNKNOWN",
] as const;

export type CanonicalClassificationLabel = (typeof CANONICAL_CLASSIFICATION_LABELS)[number];

/** 13B labels plus 13C canonical labels. */
export const CLASSIFICATION_LABELS = [
  "INTERESTED",
  "MEETING_REQUEST",
  "DEMO_REQUEST",
  "PRICING_REQUEST",
  "POSITIVE_REPLY",
  "NOT_INTERESTED",
  "UNSUBSCRIBE",
  "DO_NOT_CONTACT",
  "WRONG_PERSON",
  "OOO",
  "AUTO_REPLY",
  "REFERRAL",
  "QUESTION",
  "BOUNCE_LIKE_CONTENT",
  "NEEDS_HUMAN_REVIEW",
  "NEUTRAL",
  "UNKNOWN",
  "POSITIVE_INTEREST",
  "NEGATIVE",
  "SPAM",
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

const LABEL_SET: ReadonlySet<string> = new Set(CLASSIFICATION_LABELS);
const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_CLASSIFICATION_LABELS);

export function isClassificationLabel(value: string): value is ClassificationLabel {
  return LABEL_SET.has(value);
}

export function isCanonicalClassificationLabel(value: string): value is CanonicalClassificationLabel {
  return CANONICAL_SET.has(value);
}

/**
 * Safety-sensitive facts outrank commercial sentiment when choosing a
 * primary label. Multi-label results are still allowed.
 *
 * OOO and WRONG_PERSON share a tier; OOO is listed first as a stable tie-break.
 * NEGATIVE and REFERRAL are not in the spec's minimum chain; they sit after
 * person-level operational facts and before commercial meeting/interest.
 */
export const CLASSIFICATION_PRECEDENCE: readonly CanonicalClassificationLabel[] = [
  "UNSUBSCRIBE",
  "SPAM",
  "OOO",
  "WRONG_PERSON",
  "NEGATIVE",
  "REFERRAL",
  "MEETING_REQUEST",
  "POSITIVE_INTEREST",
  "QUESTION",
  "NEUTRAL",
  "UNKNOWN",
];

const PRECEDENCE_INDEX = new Map(CLASSIFICATION_PRECEDENCE.map((label, index) => [label, index]));

/** Labels that are GTM *facts* (not actions). UNKNOWN/NEUTRAL stay on the message but are not projected as conversation facts. */
export const CONVERSATION_FACT_LABELS = [
  "POSITIVE_REPLY",
  "INTERESTED",
  "MEETING_REQUEST",
  "DEMO_REQUEST",
  "PRICING_REQUEST",
  "NOT_INTERESTED",
  "UNSUBSCRIBE",
  "DO_NOT_CONTACT",
  "OOO",
  "WRONG_PERSON",
  "REFERRAL",
  "NEEDS_HUMAN_REVIEW",
  "POSITIVE_INTEREST",
  "NEGATIVE",
  "SPAM",
  "QUESTION",
] as const;

export type ConversationFactLabel = (typeof CONVERSATION_FACT_LABELS)[number];

const FACT_SET: ReadonlySet<string> = new Set(CONVERSATION_FACT_LABELS);

export function isConversationFactLabel(value: string): value is ConversationFactLabel {
  return FACT_SET.has(value);
}

const LEGACY_TO_CANONICAL: Readonly<Record<string, CanonicalClassificationLabel>> = {
  INTERESTED: "POSITIVE_INTEREST",
  POSITIVE_REPLY: "POSITIVE_INTEREST",
  DEMO_REQUEST: "POSITIVE_INTEREST",
  PRICING_REQUEST: "POSITIVE_INTEREST",
  POSITIVE_INTEREST: "POSITIVE_INTEREST",
  NOT_INTERESTED: "NEGATIVE",
  NEGATIVE: "NEGATIVE",
  UNSUBSCRIBE: "UNSUBSCRIBE",
  DO_NOT_CONTACT: "UNSUBSCRIBE",
  OOO: "OOO",
  AUTO_REPLY: "OOO",
  WRONG_PERSON: "WRONG_PERSON",
  REFERRAL: "REFERRAL",
  QUESTION: "QUESTION",
  MEETING_REQUEST: "MEETING_REQUEST",
  NEUTRAL: "NEUTRAL",
  SPAM: "SPAM",
  UNKNOWN: "UNKNOWN",
  BOUNCE_LIKE_CONTENT: "UNKNOWN",
};

export function toCanonicalLabel(label: string): CanonicalClassificationLabel | undefined {
  return LEGACY_TO_CANONICAL[label];
}

export function toCanonicalLabels(labels: readonly string[]): CanonicalClassificationLabel[] {
  const unique: CanonicalClassificationLabel[] = [];
  for (const label of labels) {
    const canonical = toCanonicalLabel(label);
    if (canonical && !unique.includes(canonical)) {
      unique.push(canonical);
    }
  }
  return unique;
}

export function primaryLabelByPrecedence(labels: readonly string[]): CanonicalClassificationLabel {
  const canonical = toCanonicalLabels(labels);
  if (canonical.length === 0) {
    return "UNKNOWN";
  }
  let winner = canonical[0]!;
  let best = PRECEDENCE_INDEX.get(winner) ?? Number.POSITIVE_INFINITY;
  for (const label of canonical) {
    const rank = PRECEDENCE_INDEX.get(label) ?? Number.POSITIVE_INFINITY;
    if (rank < best) {
      winner = label;
      best = rank;
    }
  }
  return winner;
}

export const SAFETY_CANONICAL_LABELS: ReadonlySet<CanonicalClassificationLabel> = new Set([
  "UNSUBSCRIBE",
  "SPAM",
  "OOO",
  "WRONG_PERSON",
]);

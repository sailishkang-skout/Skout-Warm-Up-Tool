/**
 * Provider-neutral policy signals. These are recommendations for downstream
 * systems, not actions — STOP_SEQUENCE / DELETE_CONTACT / CREATE_SUPPRESSION /
 * SEND_FOLLOWUP / BOOK_MEETING are intentionally absent.
 */
export const CONVERSATION_POLICY_VERSION = "conversation-policy/v1";
export const CONVERSATION_POLICY_TAXONOMY_VERSION = "conversation-policy-taxonomy/v1";

export const POLICY_SIGNAL_TYPES = [
  "CONTACT_SUPPRESSION_REQUIRED",
  "TEMPORARY_CONTACT_PAUSE",
  "FOLLOW_UP_OPPORTUNITY",
  "MEETING_REQUESTED",
  "CONTACT_REVIEW_REQUIRED",
  "NEGATIVE_RESPONSE",
  "SPAM_SIGNAL",
  "OUT_OF_OFFICE",
  "REFERRAL_DETECTED",
  "QUESTION_DETECTED",
  "POSITIVE_RESPONSE",
] as const;

export type PolicySignalType = (typeof POLICY_SIGNAL_TYPES)[number];

export const POLICY_SIGNAL_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type PolicySignalPriority = (typeof POLICY_SIGNAL_PRIORITIES)[number];

export const ACTION_POLICY_SIGNAL_TYPES = [
  "STOP_SEQUENCE",
  "DELETE_CONTACT",
  "CREATE_SUPPRESSION",
  "SEND_FOLLOWUP",
  "BOOK_MEETING",
] as const;

const SIGNAL_SET: ReadonlySet<string> = new Set(POLICY_SIGNAL_TYPES);

export function isPolicySignalType(value: string): value is PolicySignalType {
  return SIGNAL_SET.has(value);
}

export const POLICY_PRIORITY_RANK: Record<PolicySignalPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

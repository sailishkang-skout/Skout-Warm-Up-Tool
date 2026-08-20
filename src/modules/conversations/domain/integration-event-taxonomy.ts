/**
 * Provider-neutral integration events for future CRM / sequence / suppression
 * / analytics consumers. These are facts about what Conversation Intelligence
 * observed or recommended — never action verbs those systems must execute.
 *
 * STOP_SEQUENCE / CREATE_SUPPRESSION / CREATE_CRM_TASK / SEND_FOLLOWUP are
 * intentionally absent: they are consumer actions, not this service's contract.
 */
/** Stored as `event_version`; exposed to consumers as `schemaVersion`. */
export const INTEGRATION_EVENT_VERSION = 1;
export const INTEGRATION_CONTRACT_VERSION = "conversation-integration/v1";
/** Envelope `source` — this service, not the consuming platform. */
export const INTEGRATION_EVENT_SOURCE = "conversation-intelligence";

export const INTEGRATION_EVENT_TYPES = [
  "CONVERSATION_UPDATED",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
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
] as const;

export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

export const ACTION_INTEGRATION_EVENT_TYPES = [
  "STOP_SEQUENCE",
  "CREATE_SUPPRESSION",
  "CREATE_CRM_TASK",
  "SEND_FOLLOWUP",
] as const;

const EVENT_SET: ReadonlySet<string> = new Set(INTEGRATION_EVENT_TYPES);

export function isIntegrationEventType(value: string): value is IntegrationEventType {
  return EVENT_SET.has(value);
}

/** Policy signals that become integration events. POSITIVE_RESPONSE stays a policy signal only. */
export const POLICY_SIGNAL_INTEGRATION_EVENTS = [
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
] as const satisfies readonly IntegrationEventType[];

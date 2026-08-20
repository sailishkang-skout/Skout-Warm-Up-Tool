import { createHash } from "node:crypto";
import type { DomainFactType } from "./domain-facts.js";
import {
  CONVERSATION_POLICY_TAXONOMY_VERSION,
  CONVERSATION_POLICY_VERSION,
  POLICY_PRIORITY_RANK,
  type PolicySignalPriority,
  type PolicySignalType,
} from "./policy-signal-taxonomy.js";

/**
 * Fact-type precedence for which signals are allowed. Does not delete facts.
 * SPAM > UNSUBSCRIBE > WRONG_PERSON > NEGATIVE > OOO > MEETING_REQUEST >
 * POSITIVE_INTEREST > QUESTION > NEUTRAL > UNKNOWN
 */
export const POLICY_FACT_PRECEDENCE: readonly DomainFactType[] = [
  "SPAM",
  "UNSUBSCRIBE",
  "WRONG_PERSON",
  "NEGATIVE_INTEREST",
  "OOO",
  "MEETING_REQUEST",
  "POSITIVE_INTEREST",
  "QUESTION",
  "REFERRAL",
  "MESSAGE_RECEIVED",
];

export interface PolicySignalDraft {
  readonly signal: PolicySignalType;
  readonly priority: PolicySignalPriority;
  readonly sourceFactType: DomainFactType;
}

export interface PolicySignals {
  readonly policyVersion: string;
  readonly taxonomyVersion: string;
  readonly signals: readonly PolicySignalDraft[];
}

const COMMERCIAL_CONTINUE_SIGNALS: ReadonlySet<PolicySignalType> = new Set([
  "FOLLOW_UP_OPPORTUNITY",
  "POSITIVE_RESPONSE",
]);

function uniqueSortedFacts(facts: readonly DomainFactType[]): DomainFactType[] {
  return [...new Set(facts)].sort();
}

export function computeFactSetHash(facts: readonly DomainFactType[]): string {
  return createHash("sha256").update(uniqueSortedFacts(facts).join(",")).digest("hex");
}

function add(
  out: PolicySignalDraft[],
  signal: PolicySignalType,
  priority: PolicySignalPriority,
  sourceFactType: DomainFactType,
): void {
  if (out.some((entry) => entry.signal === signal)) {
    return;
  }
  out.push({ signal, priority, sourceFactType });
}

/**
 * Pure, deterministic mapping from domain facts to policy signals.
 * Never inspects email text, never performs I/O.
 */
export function evaluatePolicy(
  domainFacts: readonly DomainFactType[],
  options?: { readonly policyVersion?: string; readonly taxonomyVersion?: string },
): PolicySignals {
  const facts = new Set(domainFacts);
  const drafts: PolicySignalDraft[] = [];

  const hasSpam = facts.has("SPAM");
  const hasUnsubscribe = facts.has("UNSUBSCRIBE");
  const suppressionRequired = hasSpam || hasUnsubscribe;
  const hasWrongPerson = facts.has("WRONG_PERSON");
  const hasNegative = facts.has("NEGATIVE_INTEREST");
  const hasOoo = facts.has("OOO");
  const hasMeeting = facts.has("MEETING_REQUEST");
  const hasInterest = facts.has("POSITIVE_INTEREST");
  const hasReferral = facts.has("REFERRAL");
  const hasQuestion = facts.has("QUESTION");

  if (hasSpam) {
    add(drafts, "CONTACT_SUPPRESSION_REQUIRED", "CRITICAL", "SPAM");
    add(drafts, "SPAM_SIGNAL", "CRITICAL", "SPAM");
  } else if (hasUnsubscribe) {
    add(drafts, "CONTACT_SUPPRESSION_REQUIRED", "CRITICAL", "UNSUBSCRIBE");
  }

  if (!suppressionRequired) {
    if (hasWrongPerson) {
      add(drafts, "CONTACT_REVIEW_REQUIRED", "HIGH", "WRONG_PERSON");
    }
    if (hasNegative) {
      add(drafts, "NEGATIVE_RESPONSE", "HIGH", "NEGATIVE_INTEREST");
    }
    if (hasOoo) {
      add(drafts, "TEMPORARY_CONTACT_PAUSE", "HIGH", "OOO");
      add(drafts, "OUT_OF_OFFICE", "MEDIUM", "OOO");
    }
    if (hasMeeting) {
      add(drafts, "MEETING_REQUESTED", "MEDIUM", "MEETING_REQUEST");
    }
    const blockCommercial = hasWrongPerson || hasNegative || hasOoo;
    if ((hasInterest || hasMeeting) && !blockCommercial) {
      add(
        drafts,
        "FOLLOW_UP_OPPORTUNITY",
        "MEDIUM",
        hasMeeting ? "MEETING_REQUEST" : "POSITIVE_INTEREST",
      );
    }
    if (hasInterest && !blockCommercial) {
      add(drafts, "POSITIVE_RESPONSE", "MEDIUM", "POSITIVE_INTEREST");
    }
    if (hasReferral) {
      add(drafts, "REFERRAL_DETECTED", "MEDIUM", "REFERRAL");
    }
    if (hasQuestion) {
      add(drafts, "QUESTION_DETECTED", "LOW", "QUESTION");
    }
  }

  const filtered = drafts.filter((draft) => {
    if (suppressionRequired && COMMERCIAL_CONTINUE_SIGNALS.has(draft.signal)) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    const byPriority = POLICY_PRIORITY_RANK[a.priority] - POLICY_PRIORITY_RANK[b.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    return a.signal.localeCompare(b.signal);
  });

  return {
    policyVersion: options?.policyVersion ?? CONVERSATION_POLICY_VERSION,
    taxonomyVersion: options?.taxonomyVersion ?? CONVERSATION_POLICY_TAXONOMY_VERSION,
    signals: filtered,
  };
}

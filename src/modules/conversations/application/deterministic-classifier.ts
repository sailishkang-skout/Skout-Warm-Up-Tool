import type { CanonicalClassificationLabel } from "../domain/classification-taxonomy.js";
import { primaryLabelByPrecedence, SAFETY_CANONICAL_LABELS } from "../domain/classification-taxonomy.js";
import type { ClassificationEvidence, ValidatedClassification } from "../domain/classification.js";
import { confidenceBandOf } from "../domain/classification-confidence.js";
import { boundEvidence } from "./classification-evidence.js";
import { normalizeClassificationText } from "./classification-context.js";
import type { ConversationMessage } from "../domain/conversation-message.js";

export const DETERMINISTIC_CLASSIFIER_VERSION = "deterministic-classifier/v1";
export const DETERMINISTIC_RULESET_VERSION = "deterministic-rules/v1";
export const DETERMINISTIC_CONFIDENCE = 0.97;

interface DetectionRule {
  readonly label: CanonicalClassificationLabel;
  readonly ruleId: string;
  readonly patterns: readonly RegExp[];
}

/**
 * Conservative phrase detectors. Safety-sensitive rules require explicit
 * unsubscribe/OOO/wrong-person language; weak tokens like "stop" or
 * "calendar" alone do not fire.
 */
const RULES: readonly DetectionRule[] = [
  {
    label: "UNSUBSCRIBE",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/unsubscribe`,
    patterns: [
      /\bunsubscribe\b/,
      /\bremove me\b/,
      /\bstop emailing me\b/,
      /\bstop (?:emailing|mailing|contacting) (?:me|us)\b/,
      /\bdo not contact me\b/,
      /\btake me off (?:your|the) list\b/,
      /\bopt(?: |-)out\b/,
      /\bplease (?:remove|delete) (?:me|my email)\b/,
    ],
  },
  {
    label: "OOO",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/ooo`,
    patterns: [
      /\bout of office\b/,
      /\bautomatic reply\b/,
      /\bauto(?: |-)?reply\b/,
      /\bvacation responder\b/,
      /\bcurrently away\b/,
      /\baway from the office\b/,
      /\bon (?:annual )?leave until\b/,
      /\bi am (?:currently )?(?:out|away) (?:of|from) (?:the )?office\b/,
    ],
  },
  {
    label: "WRONG_PERSON",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/wrong-person`,
    patterns: [
      /\bwrong person\b/,
      /\bno longer responsible\b/,
      /\bnot the right contact\b/,
      /\byou should contact \S+ instead\b/,
      /\bplease contact \S+ instead\b/,
      /\bno longer (?:with|at) (?:the )?(?:company|team|firm)\b/,
      /\bi (?:do not|don't) (?:work|handle) (?:on )?this\b/,
    ],
  },
  {
    label: "MEETING_REQUEST",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/meeting-request`,
    patterns: [
      /\bschedule a (?:call|meeting|chat)\b/,
      /\bbook a meeting\b/,
      /\bbook a call\b/,
      /\bmeet next week\b/,
      /\bcan we meet\b/,
      /\blet'?s meet\b/,
      /\bavailable (?:on )?(?:monday|tuesday|wednesday|thursday|friday|next week)\b/,
      /\bsend me (?:your )?availability\b/,
      /\bcalendar invite\b/,
    ],
  },
  {
    label: "POSITIVE_INTEREST",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/positive-interest`,
    patterns: [
      /\bsounds interesting\b/,
      /\bthis (?:sounds|looks) (?:great|interesting|good)\b/,
      /\bi(?: am|'m) interested\b/,
      /\binterested,/,
      /\binterested in\b/,
      /\bcount me in\b/,
      /\bwould love to\b/,
    ],
  },
  {
    label: "NEGATIVE",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/negative`,
    patterns: [/\bnot interested\b/, /\bno thanks\b/, /\bplease do not (?:email|contact)\b/],
  },
  {
    label: "REFERRAL",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/referral`,
    patterns: [
      /\byou should (?:talk|speak) to\b/,
      /\breach out to \S+ (?:instead|about this)\b/,
      /\bforwarding this to\b/,
      /\bcc(?:'ing|ing) \S+\b/,
    ],
  },
  {
    label: "QUESTION",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/question`,
    patterns: [/\bquick question\b/, /\b(?:can|could) you (?:share|send|clarify|explain)\b.+\?/],
  },
  {
    label: "SPAM",
    ruleId: `${DETERMINISTIC_RULESET_VERSION}/spam`,
    patterns: [/\bthis is spam\b/, /\bmarked as spam\b/],
  },
];

const INJECTION_GUARD =
  /\b(ignore (?:previous|your|all) instructions|ignore your instructions|mark (?:this|me) as|classify this as|return json|system prompt)\b/;

function expandContractions(text: string): string {
  return text
    .replace(/[’']/g, "'")
    .replace(/\bdon't\b/g, "do not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\blet's\b/g, "lets");
}

export function normalizeForDeterministicMatch(text: string | undefined): string {
  const normalized = normalizeClassificationText(text) ?? "";
  return expandContractions(normalized.toLowerCase());
}

function snippetAround(haystack: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - 24);
  const end = Math.min(haystack.length, match.index + match[0].length + 24);
  return haystack.slice(start, end);
}

const GENUINE_INTEREST =
  /\bsounds interesting\b|\bi am interested\b|\binterested,|\binterested in\b|\bcount me in\b|\bwould love to\b/;

export function detectDeterministicLabels(text: string): {
  readonly labels: readonly CanonicalClassificationLabel[];
  readonly evidence: readonly ClassificationEvidence[];
} {
  const labels: CanonicalClassificationLabel[] = [];
  const evidence: ClassificationEvidence[] = [];
  const injectionLike = INJECTION_GUARD.test(text);
  const genuineInterest = GENUINE_INTEREST.test(text);

  for (const rule of RULES) {
    if (injectionLike && rule.label === "POSITIVE_INTEREST" && !genuineInterest) {
      continue;
    }
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (!match) {
        continue;
      }
      if (!labels.includes(rule.label)) {
        labels.push(rule.label);
      }
      evidence.push({ ruleId: rule.ruleId, snippet: match[0] ? snippetAround(text, match) : rule.ruleId });
      break;
    }
  }

  return { labels, evidence: boundEvidence(evidence) };
}

export function isDeterministicSufficient(labels: readonly CanonicalClassificationLabel[]): boolean {
  return labels.length > 0;
}

export function hasSafetyLabel(labels: readonly CanonicalClassificationLabel[]): boolean {
  return labels.some((label) => SAFETY_CANONICAL_LABELS.has(label));
}

export function classifyDeterministic(message: ConversationMessage): ValidatedClassification | undefined {
  const text = normalizeForDeterministicMatch([message.subject, message.textBody].filter(Boolean).join(" "));
  const detected = detectDeterministicLabels(text);
  if (detected.labels.length === 0) {
    return undefined;
  }
  const primaryLabel = primaryLabelByPrecedence(detected.labels);
  return {
    labels: detected.labels,
    primaryLabel,
    confidence: DETERMINISTIC_CONFIDENCE,
    confidenceBand: confidenceBandOf(DETERMINISTIC_CONFIDENCE),
    reason: `Matched ${detected.evidence.map((item) => item.ruleId).join(", ")}`,
    evidence: detected.evidence,
    classifierType: "DETERMINISTIC",
  };
}

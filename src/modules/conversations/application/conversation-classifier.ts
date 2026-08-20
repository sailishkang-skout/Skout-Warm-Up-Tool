import { PermanentError } from "../../../shared/errors/index.js";
import type { ConversationMessage } from "../domain/conversation-message.js";
import { confidenceBandOf } from "../domain/classification-confidence.js";
import type { ValidatedClassification } from "../domain/classification.js";
import { primaryLabelByPrecedence, toCanonicalLabels } from "../domain/classification-taxonomy.js";
import type { AiClassifierProvider } from "./ai-classifier-provider.js";
import {
  CLASSIFICATION_RECENT_BODY_CHARS,
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationUserPayload,
  toClassificationMessageView,
  truncateUserPayload,
} from "./classification-context.js";
import { boundEvidence } from "./classification-evidence.js";
import { validateClassificationOutput } from "./classification-validation.js";
import { classifyDeterministic, isDeterministicSufficient } from "./deterministic-classifier.js";

export interface ConversationClassifier {
  classify(current: ConversationMessage, recent: readonly ConversationMessage[]): Promise<ValidatedClassification>;
}

export interface CreateValidatingConversationClassifierDeps {
  readonly aiProvider: AiClassifierProvider;
  readonly maxInputChars: number;
}

export function createValidatingConversationClassifier(
  deps: CreateValidatingConversationClassifierDeps,
): ConversationClassifier {
  const { aiProvider, maxInputChars } = deps;

  return {
    async classify(current: ConversationMessage, recent: readonly ConversationMessage[]): Promise<ValidatedClassification> {
      const currentView = toClassificationMessageView(current, maxInputChars);
      const recentViews = recent.map((message) => toClassificationMessageView(message, CLASSIFICATION_RECENT_BODY_CHARS));
      const userPayload = truncateUserPayload(buildClassificationUserPayload(currentView, recentViews), maxInputChars);
      const raw = await aiProvider.classifyRaw({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userPayload,
      });
      try {
        return validateClassificationOutput(raw);
      } catch (error) {
        if (error instanceof Error) {
          throw error;
        }
        throw new PermanentError("Classifier output could not be validated");
      }
    },
  };
}

export const UNKNOWN_WITHOUT_AI: ValidatedClassification = {
  labels: ["UNKNOWN"],
  primaryLabel: "UNKNOWN",
  confidence: 0,
  confidenceBand: "LOW",
  reason: "No deterministic match and AI classification is not configured",
  classifierType: "DETERMINISTIC",
};

export function mergeClassifications(
  deterministic: ValidatedClassification,
  ai: ValidatedClassification,
): ValidatedClassification {
  const labels = toCanonicalLabels([...deterministic.labels, ...ai.labels]);
  const primaryLabel = primaryLabelByPrecedence(labels);
  const evidence = boundEvidence([...(deterministic.evidence ?? []), ...(ai.evidence ?? [])]);
  const primaryFromDeterministic = toCanonicalLabels(deterministic.labels).includes(primaryLabel);
  return {
    labels,
    primaryLabel,
    confidence: primaryFromDeterministic ? deterministic.confidence : ai.confidence,
    confidenceBand: confidenceBandOf(primaryFromDeterministic ? deterministic.confidence : ai.confidence),
    reason: [deterministic.reason, ai.reason].filter(Boolean).join("; ").slice(0, 280),
    ...(evidence.length > 0 ? { evidence } : {}),
    classifierType: "HYBRID",
  };
}

export interface CreateHybridConversationClassifierDeps {
  readonly aiClassifier?: ConversationClassifier;
  readonly supplementDeterministic: boolean;
}

export function createHybridConversationClassifier(deps: CreateHybridConversationClassifierDeps): ConversationClassifier {
  const { aiClassifier, supplementDeterministic } = deps;

  return {
    async classify(current: ConversationMessage, recent: readonly ConversationMessage[]): Promise<ValidatedClassification> {
      const deterministic = classifyDeterministic(current);
      const sufficient = deterministic !== undefined && isDeterministicSufficient(toCanonicalLabels(deterministic.labels));
      if (sufficient && deterministic && (!supplementDeterministic || !aiClassifier)) {
        return {
          ...deterministic,
          labels: toCanonicalLabels(deterministic.labels),
          primaryLabel: primaryLabelByPrecedence(deterministic.labels),
        };
      }
      if (!aiClassifier) {
        return UNKNOWN_WITHOUT_AI;
      }
      const ai = await aiClassifier.classify(current, recent);
      const canonicalAi: ValidatedClassification = {
        ...ai,
        labels: toCanonicalLabels(ai.labels),
        primaryLabel: primaryLabelByPrecedence(ai.labels.length > 0 ? ai.labels : ["UNKNOWN"]),
        classifierType: ai.classifierType ?? "AI",
      };
      if (!deterministic) {
        return canonicalAi;
      }
      return mergeClassifications(deterministic, canonicalAi);
    },
  };
}

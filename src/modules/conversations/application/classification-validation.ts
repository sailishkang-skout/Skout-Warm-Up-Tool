import { PermanentError, ValidationError } from "../../../shared/errors/index.js";
import { confidenceBandOf, WEAK_CONFIDENCE_MAX } from "../domain/classification-confidence.js";
import type { ClassificationEvidence, ValidatedClassification } from "../domain/classification.js";
import { isClassificationLabel, type ClassificationLabel } from "../domain/classification-taxonomy.js";
import { boundEvidence } from "./classification-evidence.js";

const REASON_MAX_CHARS = 280;
const ACTION_LABELS = new Set(["STOP_SEQUENCE", "CREATE_CRM_TASK", "ADD_SUPPRESSION", "SEND_FOLLOWUP", "BOOK_MEETING"]);

function parseEvidence(raw: unknown): readonly ClassificationEvidence[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new PermanentError("Classifier returned invalid evidence");
  }
  const items: ClassificationEvidence[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PermanentError("Classifier returned invalid evidence");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.ruleId !== "string" || typeof record.snippet !== "string") {
      throw new PermanentError("Classifier returned invalid evidence");
    }
    items.push({ ruleId: record.ruleId, snippet: record.snippet });
  }
  return boundEvidence(items);
}

export function validateClassificationOutput(raw: unknown): ValidatedClassification {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PermanentError("Classifier returned a non-object payload");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.system === "string" || typeof record.instructions === "string") {
    throw new PermanentError("Classifier output attempted to inject instructions");
  }

  const labelsRaw = record.labels;
  if (!Array.isArray(labelsRaw) || labelsRaw.length === 0) {
    throw new ValidationError("Classifier labels must be a non-empty array");
  }
  const labels: ClassificationLabel[] = [];
  for (const item of labelsRaw) {
    if (typeof item !== "string") {
      throw new PermanentError("Classifier returned an unknown label");
    }
    if (ACTION_LABELS.has(item)) {
      throw new PermanentError("Classifier returned an unknown label");
    }
    if (!isClassificationLabel(item)) {
      throw new PermanentError("Classifier returned an unknown label");
    }
    if (!labels.includes(item)) {
      labels.push(item);
    }
  }

  if (typeof record.primaryLabel !== "string" || !isClassificationLabel(record.primaryLabel)) {
    throw new PermanentError("Classifier returned an invalid primary label");
  }
  if (!labels.includes(record.primaryLabel)) {
    throw new PermanentError("Classifier primary label is not present in labels");
  }

  const confidence = typeof record.confidence === "number" ? record.confidence : Number(record.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new PermanentError("Classifier returned an invalid confidence");
  }

  if (typeof record.reason !== "string" || record.reason.trim() === "") {
    throw new PermanentError("Classifier returned an invalid reason");
  }

  const evidence = parseEvidence(record.evidence);
  const weak = confidence < WEAK_CONFIDENCE_MAX;
  const allowedWeak = labels.every((label) => label === "UNKNOWN" || label === "NEUTRAL");
  if (weak && !allowedWeak) {
    return {
      labels: ["UNKNOWN"],
      primaryLabel: "UNKNOWN",
      confidence,
      confidenceBand: confidenceBandOf(confidence),
      reason: "Weak classifier score; not treated as a positive or negative fact",
      ...(evidence ? { evidence } : {}),
      classifierType: "AI",
    };
  }

  return {
    labels,
    primaryLabel: record.primaryLabel,
    confidence,
    confidenceBand: confidenceBandOf(confidence),
    reason: record.reason.trim().slice(0, REASON_MAX_CHARS),
    ...(evidence ? { evidence } : {}),
    classifierType: "AI",
  };
}

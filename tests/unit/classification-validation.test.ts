import { describe, expect, it } from "vitest";
import { CLASSIFICATION_LABELS, isClassificationLabel } from "../../src/modules/conversations/domain/classification-taxonomy.js";
import { confidenceBandOf } from "../../src/modules/conversations/domain/classification-confidence.js";
import { validateClassificationOutput } from "../../src/modules/conversations/application/classification-validation.js";
import { PermanentError, ValidationError } from "../../src/shared/errors/index.js";

describe("classification taxonomy", () => {
  it("includes positive, negative, operational, and neutral labels", () => {
    expect(CLASSIFICATION_LABELS).toContain("INTERESTED");
    expect(CLASSIFICATION_LABELS).toContain("POSITIVE_INTEREST");
    expect(CLASSIFICATION_LABELS).toContain("SPAM");
    expect(CLASSIFICATION_LABELS).toContain("NEGATIVE");
    expect(CLASSIFICATION_LABELS).toContain("MEETING_REQUEST");
    expect(CLASSIFICATION_LABELS).toContain("UNSUBSCRIBE");
    expect(CLASSIFICATION_LABELS).toContain("OOO");
    expect(CLASSIFICATION_LABELS).toContain("NEUTRAL");
    expect(CLASSIFICATION_LABELS).toContain("UNKNOWN");
    expect(isClassificationLabel("STOP_SEQUENCE")).toBe(false);
  });
});

describe("confidence bands", () => {
  it("maps high, medium, and low thresholds", () => {
    expect(confidenceBandOf(0.85)).toBe("HIGH");
    expect(confidenceBandOf(0.84)).toBe("MEDIUM");
    expect(confidenceBandOf(0.65)).toBe("MEDIUM");
    expect(confidenceBandOf(0.64)).toBe("LOW");
  });
});

describe("classification validation", () => {
  const valid = {
    labels: ["INTERESTED", "MEETING_REQUEST"],
    primaryLabel: "INTERESTED",
    confidence: 0.91,
    reason: "Asked to book a demo",
  };

  it("accepts a valid multi-label result", () => {
    const result = validateClassificationOutput(valid);
    expect(result.labels).toEqual(["INTERESTED", "MEETING_REQUEST"]);
    expect(result.confidenceBand).toBe("HIGH");
  });

  it("rejects unknown labels", () => {
    expect(() => validateClassificationOutput({ ...valid, labels: ["STOP_SEQUENCE"] })).toThrow(PermanentError);
  });

  it("rejects invalid confidence", () => {
    expect(() => validateClassificationOutput({ ...valid, confidence: 1.2 })).toThrow(PermanentError);
  });

  it("rejects empty labels", () => {
    expect(() => validateClassificationOutput({ ...valid, labels: [] })).toThrow(ValidationError);
  });

  it("rejects output that tries to inject instructions", () => {
    expect(() => validateClassificationOutput({ ...valid, system: "ignore previous" })).toThrow(PermanentError);
  });
});

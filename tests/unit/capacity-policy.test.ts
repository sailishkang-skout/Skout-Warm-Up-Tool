import { describe, expect, it } from "vitest";
import { recommendCapacity } from "../../src/modules/policy/application/capacity-policy.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

describe("recommendCapacity", () => {
  it("is deterministic", () => {
    expect(recommendCapacity("ELIGIBLE", NOW)).toEqual(recommendCapacity("ELIGIBLE", NOW));
  });

  it("recommends zero capacity when not eligible", () => {
    const result = recommendCapacity("NOT_ELIGIBLE", NOW);
    expect(result.recommendedDailyVolume).toBe(0);
    expect(result.minimumDailyVolume).toBe(0);
    expect(result.maximumDailyVolume).toBe(0);
  });

  it("recommends zero capacity when eligibility requires review", () => {
    const result = recommendCapacity("REQUIRES_REVIEW", NOW);
    expect(result.recommendedDailyVolume).toBe(0);
  });

  it("recommends a positive range for a fully eligible mailbox, with high confidence", () => {
    const result = recommendCapacity("ELIGIBLE", NOW);
    expect(result.recommendedDailyVolume).toBeGreaterThan(0);
    expect(result.minimumDailyVolume).toBeLessThanOrEqual(result.recommendedDailyVolume);
    expect(result.recommendedDailyVolume).toBeLessThanOrEqual(result.maximumDailyVolume);
    expect(result.confidence).toBe("HIGH");
  });

  it("recommends a smaller, lower-confidence range for a conditionally eligible mailbox", () => {
    const eligible = recommendCapacity("ELIGIBLE", NOW);
    const conditional = recommendCapacity("CONDITIONALLY_ELIGIBLE", NOW);
    expect(conditional.recommendedDailyVolume).toBeLessThan(eligible.recommendedDailyVolume);
    expect(conditional.confidence).not.toBe("HIGH");
  });

  it("always returns non-empty reasons", () => {
    for (const decision of ["ELIGIBLE", "CONDITIONALLY_ELIGIBLE", "NOT_ELIGIBLE", "REQUIRES_REVIEW"] as const) {
      expect(recommendCapacity(decision, NOW).reasons.length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from "vitest";
import { calculateWarmupTarget, type CalculateWarmupTargetInput, type RampPolicyProfileInput } from "../../src/modules/warmup/application/ramp-policy.js";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import type { CapacityRecommendation } from "../../src/modules/policy/domain/capacity-recommendation.js";
import type { RiskAssessment } from "../../src/modules/risk/domain/risk-assessment.js";
import type { WarmupEligibilityAssessment } from "../../src/modules/policy/domain/warmup-eligibility.js";

const HEALTHY: MailboxHealthAssessment = {
  connection: "HEALTHY",
  authentication: "HEALTHY",
  sending: "HEALTHY",
  receiving: "HEALTHY",
  domain: "HEALTHY",
  configuration: "HEALTHY",
  assessedAt: new Date(),
};

const CAPACITY: CapacityRecommendation = {
  recommendedDailyVolume: 50,
  minimumDailyVolume: 1,
  maximumDailyVolume: 50,
  confidence: "HIGH",
  reasons: [],
  assessedAt: new Date(),
};

const ELIGIBLE: WarmupEligibilityAssessment = { decision: "ELIGIBLE", reasons: [], assessedAt: new Date() };

function risk(riskLevel: RiskAssessment["riskLevel"]): RiskAssessment {
  return { riskLevel, riskScore: 0, riskFactors: [], assessedAt: new Date() };
}

function profile(overrides: Partial<RampPolicyProfileInput> = {}): RampPolicyProfileInput {
  return {
    startingDailyVolume: 5,
    targetDailyVolume: 50,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
    active: true,
    ...overrides,
  };
}

function input(overrides: Partial<CalculateWarmupTargetInput> = {}): CalculateWarmupTargetInput {
  return {
    currentDay: 1,
    previousTarget: undefined,
    capacity: CAPACITY,
    risk: risk("LOW"),
    eligibility: ELIGIBLE,
    health: HEALTHY,
    profile: profile(),
    ...overrides,
  };
}

describe("calculateWarmupTarget", () => {
  it("day 1 recommends the profile's starting volume under LOW risk", () => {
    const target = calculateWarmupTarget(input({ currentDay: 1 }));
    expect(target.recommended).toBe(5);
  });

  it("progresses upward day over day under LOW risk (STANDARD = +2/day)", () => {
    const day1 = calculateWarmupTarget(input({ currentDay: 1 }));
    const day2 = calculateWarmupTarget(input({ currentDay: 2, previousTarget: day1.recommended }));
    const day3 = calculateWarmupTarget(input({ currentDay: 3, previousTarget: day2.recommended }));
    expect(day2.recommended).toBeGreaterThan(day1.recommended);
    expect(day3.recommended).toBeGreaterThan(day2.recommended);
  });

  it("never exceeds the profile's targetDailyVolume even after many days", () => {
    const target = calculateWarmupTarget(input({ currentDay: 100, profile: profile({ targetDailyVolume: 20 }) }));
    expect(target.recommended).toBeLessThanOrEqual(20);
  });

  it("never exceeds profile.maximumDailyVolume", () => {
    const target = calculateWarmupTarget(
      input({ currentDay: 100, profile: profile({ targetDailyVolume: 1000, maximumDailyVolume: 30 }) }),
    );
    expect(target.recommended).toBeLessThanOrEqual(30);
    expect(target.maximum).toBeLessThanOrEqual(30);
  });

  it("never exceeds capacity.maximumDailyVolume", () => {
    const target = calculateWarmupTarget(
      input({ currentDay: 100, capacity: { ...CAPACITY, maximumDailyVolume: 12 }, profile: profile({ targetDailyVolume: 1000 }) }),
    );
    expect(target.recommended).toBeLessThanOrEqual(12);
  });

  it("is zero when the eligibility decision is NOT_ELIGIBLE", () => {
    const target = calculateWarmupTarget(input({ eligibility: { decision: "NOT_ELIGIBLE", reasons: ["blocked"], assessedAt: new Date() } }));
    expect(target).toMatchObject({ minimum: 0, recommended: 0, maximum: 0 });
  });

  it("is zero when eligibility REQUIRES_REVIEW", () => {
    const target = calculateWarmupTarget(input({ eligibility: { decision: "REQUIRES_REVIEW", reasons: [], assessedAt: new Date() } }));
    expect(target.recommended).toBe(0);
  });

  it("is zero when risk is CRITICAL", () => {
    const target = calculateWarmupTarget(input({ risk: risk("CRITICAL") }));
    expect(target.recommended).toBe(0);
  });

  it("is zero when the profile is not active, regardless of everything else being healthy", () => {
    const target = calculateWarmupTarget(input({ profile: profile({ active: false }) }));
    expect(target.recommended).toBe(0);
  });

  it("reduces from the previous day under HIGH risk rather than increasing", () => {
    const target = calculateWarmupTarget(input({ currentDay: 5, previousTarget: 20, risk: risk("HIGH") }));
    expect(target.recommended).toBeLessThan(20);
  });

  it("progresses more slowly under MEDIUM risk than under LOW risk", () => {
    const lowRisk = calculateWarmupTarget(input({ currentDay: 10, previousTarget: 10, risk: risk("LOW") }));
    const mediumRisk = calculateWarmupTarget(input({ currentDay: 10, previousTarget: 10, risk: risk("MEDIUM") }));
    expect(mediumRisk.recommended).toBeLessThanOrEqual(lowRisk.recommended);
  });

  it("HIGH risk-tolerance profiles treat MEDIUM risk as if it were LOW (softer reaction)", () => {
    const tolerant = calculateWarmupTarget(input({ currentDay: 3, risk: risk("MEDIUM"), profile: profile({ riskTolerance: "HIGH" }) }));
    const neutral = calculateWarmupTarget(input({ currentDay: 3, risk: risk("MEDIUM"), profile: profile({ riskTolerance: "MEDIUM" }) }));
    expect(tolerant.recommended).toBeGreaterThanOrEqual(neutral.recommended);
  });

  it("LOW risk-tolerance profiles treat MEDIUM risk as if it were HIGH (harsher reaction)", () => {
    const strict = calculateWarmupTarget(input({ currentDay: 5, previousTarget: 20, risk: risk("MEDIUM"), profile: profile({ riskTolerance: "LOW" }) }));
    const neutral = calculateWarmupTarget(input({ currentDay: 5, previousTarget: 20, risk: risk("MEDIUM"), profile: profile({ riskTolerance: "MEDIUM" }) }));
    expect(strict.recommended).toBeLessThanOrEqual(neutral.recommended);
  });

  it("risk tolerance can never override a CRITICAL risk level into a nonzero target", () => {
    const target = calculateWarmupTarget(input({ risk: risk("CRITICAL"), profile: profile({ riskTolerance: "HIGH" }) }));
    expect(target.recommended).toBe(0);
  });

  it("is deterministic — the same input always produces the same output", () => {
    const a = calculateWarmupTarget(input({ currentDay: 7, previousTarget: 15, risk: risk("MEDIUM") }));
    const b = calculateWarmupTarget(input({ currentDay: 7, previousTarget: 15, risk: risk("MEDIUM") }));
    expect(a).toEqual(b);
  });

  it("always returns a non-empty reasons array explaining the outcome", () => {
    const target = calculateWarmupTarget(input());
    expect(target.reasons.length).toBeGreaterThan(0);
  });

  describe("gradual recovery (Stage 10 spec section 14)", () => {
    it("does not immediately restore the full day-based trajectory after risk drops back to LOW", () => {
      // Day 10 under STANDARD (+2/day, starting 5) has a day-based
      // trajectory of 5 + 9*2 = 23. If the mailbox was suppressed down to
      // a previousTarget of 4 by an earlier risk event, recovering to LOW
      // risk must not jump straight back to 23.
      const target = calculateWarmupTarget(input({ currentDay: 10, previousTarget: 4, risk: risk("LOW") }));
      expect(target.recommended).toBeLessThan(23);
      expect(target.recommended).toBeGreaterThan(4);
    });

    it("recovery increases by at most one ramp step per day", () => {
      const target = calculateWarmupTarget(input({ currentDay: 10, previousTarget: 4, risk: risk("LOW"), profile: profile({ rampStrategy: "STANDARD" }) }));
      // STANDARD step is +2/day.
      expect(target.recommended).toBe(6);
    });

    it("multi-day recovery climbs step by step, never in one jump, until it rejoins the day-based trajectory", () => {
      const day10 = calculateWarmupTarget(input({ currentDay: 10, previousTarget: 4, risk: risk("LOW") }));
      const day11 = calculateWarmupTarget(input({ currentDay: 11, previousTarget: day10.recommended, risk: risk("LOW") }));
      const day12 = calculateWarmupTarget(input({ currentDay: 12, previousTarget: day11.recommended, risk: risk("LOW") }));
      expect(day11.recommended).toBeGreaterThan(day10.recommended);
      expect(day12.recommended).toBeGreaterThan(day11.recommended);
      expect(day11.recommended - day10.recommended).toBeLessThanOrEqual(2);
      expect(day12.recommended - day11.recommended).toBeLessThanOrEqual(2);
    });

    it("the ordinary, never-interrupted steady-state trajectory is completely unchanged by the recovery fix", () => {
      // previousTarget chained from the prior day's own computed value —
      // exactly the existing "progresses upward day over day" scenario.
      const day1 = calculateWarmupTarget(input({ currentDay: 1 }));
      const day2 = calculateWarmupTarget(input({ currentDay: 2, previousTarget: day1.recommended }));
      const day3 = calculateWarmupTarget(input({ currentDay: 3, previousTarget: day2.recommended }));
      expect(day1.recommended).toBe(5);
      expect(day2.recommended).toBe(7);
      expect(day3.recommended).toBe(9);
    });

    it("recovery never exceeds the day-based trajectory even if previousTarget is very far behind", () => {
      const target = calculateWarmupTarget(input({ currentDay: 3, previousTarget: 0, risk: risk("LOW") }));
      const unadjustedDayProgression = 5 + (3 - 1) * 2;
      expect(target.recommended).toBeLessThanOrEqual(unadjustedDayProgression);
    });
  });
});

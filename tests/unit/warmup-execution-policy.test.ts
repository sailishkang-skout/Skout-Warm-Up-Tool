import { describe, expect, it } from "vitest";
import { decideWarmupExecution, type WarmupExecutionPolicyInput } from "../../src/modules/warmup/application/warmup-execution-policy.js";
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

function risk(riskLevel: RiskAssessment["riskLevel"]): RiskAssessment {
  return { riskLevel, riskScore: 0, riskFactors: [], assessedAt: new Date() };
}

function eligibility(decision: WarmupEligibilityAssessment["decision"], reasons: string[] = []): WarmupEligibilityAssessment {
  return { decision, reasons, assessedAt: new Date() };
}

function input(overrides: Partial<WarmupExecutionPolicyInput> = {}): WarmupExecutionPolicyInput {
  return {
    sessionState: "ACTIVE",
    currentDay: 1,
    previousTarget: undefined,
    mailboxEnabled: true,
    health: HEALTHY,
    risk: risk("LOW"),
    eligibility: eligibility("ELIGIBLE"),
    capacity: CAPACITY,
    providerCanSend: true,
    profile: {
      startingDailyVolume: 5,
      targetDailyVolume: 50,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
      active: true,
      pauseConditions: [],
    },
    ...overrides,
  };
}

describe("decideWarmupExecution", () => {
  it("PROCEEDs when everything is healthy and volume did not decrease", () => {
    const outcome = decideWarmupExecution(input());
    expect(outcome.decision).toBe("PROCEED");
    expect(outcome.target.recommended).toBeGreaterThan(0);
  });

  it("REVIEWs when eligibility itself is REQUIRES_REVIEW, before anything else is considered", () => {
    const outcome = decideWarmupExecution(input({ eligibility: eligibility("REQUIRES_REVIEW"), risk: risk("CRITICAL") }));
    expect(outcome.decision).toBe("REVIEW");
  });

  it("BLOCKs when eligibility is NOT_ELIGIBLE", () => {
    const outcome = decideWarmupExecution(input({ eligibility: eligibility("NOT_ELIGIBLE") }));
    expect(outcome.decision).toBe("BLOCK");
  });

  it("PAUSEs on CRITICAL risk", () => {
    const outcome = decideWarmupExecution(input({ risk: risk("CRITICAL") }));
    expect(outcome.decision).toBe("PAUSE");
    expect(outcome.reasonCodes).toContain("RISK_CRITICAL");
  });

  it("PAUSEs when the session is already in COOLDOWN", () => {
    const outcome = decideWarmupExecution(input({ sessionState: "COOLDOWN" }));
    expect(outcome.decision).toBe("PAUSE");
  });

  it("PAUSEs when a profile pause condition is currently matched", () => {
    const outcome = decideWarmupExecution(
      input({ risk: risk("CRITICAL"), profile: { ...input().profile, pauseConditions: ["RISK_CRITICAL"] } }),
    );
    expect(outcome.decision).toBe("PAUSE");
  });

  it("BLOCKs when the session is not ACTIVE (and not COOLDOWN)", () => {
    const outcome = decideWarmupExecution(input({ sessionState: "PAUSED" }));
    expect(outcome.decision).toBe("BLOCK");
  });

  it("BLOCKs when the mailbox is disconnected", () => {
    const outcome = decideWarmupExecution(input({ health: { ...HEALTHY, connection: "UNHEALTHY" } }));
    expect(outcome.decision).toBe("BLOCK");
  });

  it("BLOCKs when send capability is unhealthy", () => {
    const outcome = decideWarmupExecution(input({ health: { ...HEALTHY, sending: "UNHEALTHY" } }));
    expect(outcome.decision).toBe("BLOCK");
  });

  it("BLOCKs when the provider does not currently support sending", () => {
    const outcome = decideWarmupExecution(input({ providerCanSend: false }));
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.reasonCodes).toContain("PROVIDER_SEND_UNAVAILABLE");
  });

  it("REDUCEs when volume genuinely decreased from the previous day but nothing hard-blocks", () => {
    const outcome = decideWarmupExecution(input({ currentDay: 5, previousTarget: 30, risk: risk("HIGH") }));
    expect(outcome.decision).toBe("REDUCE");
    expect(outcome.target.recommended).toBeLessThan(30);
  });

  it("PROCEEDs (not REDUCE) on the very first day with no previous target to compare against", () => {
    const outcome = decideWarmupExecution(input({ currentDay: 1, previousTarget: undefined, risk: risk("HIGH") }));
    expect(outcome.decision).not.toBe("REDUCE");
  });

  it("always returns a target alongside the decision, even when BLOCK/PAUSE/REVIEW", () => {
    const outcome = decideWarmupExecution(input({ eligibility: eligibility("NOT_ELIGIBLE") }));
    expect(outcome.target).toBeDefined();
    expect(outcome.target.recommended).toBe(0);
  });

  it("is deterministic", () => {
    const a = decideWarmupExecution(input({ currentDay: 4, previousTarget: 10, risk: risk("MEDIUM") }));
    const b = decideWarmupExecution(input({ currentDay: 4, previousTarget: 10, risk: risk("MEDIUM") }));
    expect(a).toEqual(b);
  });
});

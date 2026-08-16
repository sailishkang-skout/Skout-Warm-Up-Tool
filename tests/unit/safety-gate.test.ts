import { describe, expect, it } from "vitest";
import { evaluateSafetyGate, type SafetyGateInput } from "../../src/modules/warmup/application/safety-gate.js";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";

const HEALTHY: MailboxHealthAssessment = {
  connection: "HEALTHY",
  authentication: "HEALTHY",
  sending: "HEALTHY",
  receiving: "HEALTHY",
  domain: "HEALTHY",
  configuration: "HEALTHY",
  assessedAt: new Date(),
};

function baseInput(overrides: Partial<SafetyGateInput> = {}): SafetyGateInput {
  return {
    sessionState: "ACTIVE",
    mailboxEnabled: true,
    health: HEALTHY,
    riskLevel: "LOW",
    eligibility: "ELIGIBLE",
    recommendedVolume: 5,
    maximumVolume: 10,
    profileActive: true,
    pauseConditions: [],
    providerCanSend: true,
    ...overrides,
  };
}

describe("evaluateSafetyGate", () => {
  it("passes when every mandatory condition is satisfied", () => {
    const result = evaluateSafetyGate(baseInput());
    expect(result.passed).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it("blocks when the session is not ACTIVE", () => {
    const result = evaluateSafetyGate(baseInput({ sessionState: "PAUSED" }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("SESSION_NOT_ACTIVE");
  });

  it("flags COOLDOWN distinctly from a generic non-active session", () => {
    const result = evaluateSafetyGate(baseInput({ sessionState: "COOLDOWN" }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("COOLDOWN_ACTIVE");
    expect(result.reasonCodes).not.toContain("SESSION_NOT_ACTIVE");
  });

  it("blocks when the profile is not active", () => {
    const result = evaluateSafetyGate(baseInput({ profileActive: false }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("PROFILE_INACTIVE");
  });

  it("blocks when eligibility is NOT_ELIGIBLE", () => {
    const result = evaluateSafetyGate(baseInput({ eligibility: "NOT_ELIGIBLE" }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("NOT_ELIGIBLE");
  });

  it("blocks when eligibility REQUIRES_REVIEW", () => {
    const result = evaluateSafetyGate(baseInput({ eligibility: "REQUIRES_REVIEW" }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("REQUIRES_REVIEW");
  });

  it("blocks on CRITICAL risk", () => {
    const result = evaluateSafetyGate(baseInput({ riskLevel: "CRITICAL" }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("RISK_CRITICAL");
  });

  it("allows HIGH risk through — reduction is the ramp policy's job (REDUCE), not this gate's (that would incorrectly always BLOCK instead)", () => {
    const result = evaluateSafetyGate(baseInput({ riskLevel: "HIGH" }));
    expect(result.passed).toBe(true);
    expect(result.reasonCodes).toContain("RISK_HIGH");
  });

  it("allows MEDIUM risk through (reduced volume handled upstream by the ramp policy, not blocked here)", () => {
    const result = evaluateSafetyGate(baseInput({ riskLevel: "MEDIUM" }));
    expect(result.passed).toBe(true);
  });

  it("blocks when the mailbox is disabled", () => {
    const result = evaluateSafetyGate(baseInput({ mailboxEnabled: false }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("PROVIDER_DISCONNECTED");
  });

  it("blocks when connection health is not HEALTHY", () => {
    const result = evaluateSafetyGate(baseInput({ health: { ...HEALTHY, connection: "UNHEALTHY" } }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("PROVIDER_DISCONNECTED");
  });

  it("blocks when authentication health is not HEALTHY", () => {
    const result = evaluateSafetyGate(baseInput({ health: { ...HEALTHY, authentication: "DEGRADED" } }));
    expect(result.passed).toBe(false);
  });

  it("blocks when send capability is not HEALTHY", () => {
    const result = evaluateSafetyGate(baseInput({ health: { ...HEALTHY, sending: "UNHEALTHY" } }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("SEND_CAPABILITY_UNHEALTHY");
  });

  it("blocks when the provider does not currently support sending", () => {
    const result = evaluateSafetyGate(baseInput({ providerCanSend: false }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("PROVIDER_SEND_UNAVAILABLE");
  });

  it("blocks when recommended volume is zero", () => {
    const result = evaluateSafetyGate(baseInput({ recommendedVolume: 0 }));
    expect(result.passed).toBe(false);
  });

  it("blocks when recommended volume exceeds the maximum bound", () => {
    const result = evaluateSafetyGate(baseInput({ recommendedVolume: 20, maximumVolume: 10 }));
    expect(result.passed).toBe(false);
  });

  it("matches a RISK_CRITICAL pause condition when risk is CRITICAL", () => {
    const result = evaluateSafetyGate(baseInput({ riskLevel: "CRITICAL", pauseConditions: ["RISK_CRITICAL"] }));
    expect(result.reasonCodes).toContain("PAUSE_CONDITION_MATCHED");
  });

  it("matches a PROVIDER_DISCONNECTED pause condition when disconnected", () => {
    const result = evaluateSafetyGate(
      baseInput({ health: { ...HEALTHY, connection: "UNHEALTHY" }, pauseConditions: ["PROVIDER_DISCONNECTED"] }),
    );
    expect(result.reasonCodes).toContain("PAUSE_CONDITION_MATCHED");
  });

  it("does not match a pause condition that isn't currently true", () => {
    const result = evaluateSafetyGate(baseInput({ pauseConditions: ["RISK_CRITICAL", "PROVIDER_DISCONNECTED"] }));
    expect(result.passed).toBe(true);
    expect(result.reasonCodes).not.toContain("PAUSE_CONDITION_MATCHED");
  });

  it("collects every failing condition rather than stopping at the first", () => {
    const result = evaluateSafetyGate(
      baseInput({ sessionState: "PAUSED", profileActive: false, eligibility: "NOT_ELIGIBLE", riskLevel: "CRITICAL" }),
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["SESSION_NOT_ACTIVE", "PROFILE_INACTIVE", "NOT_ELIGIBLE", "RISK_CRITICAL"]),
    );
  });
});

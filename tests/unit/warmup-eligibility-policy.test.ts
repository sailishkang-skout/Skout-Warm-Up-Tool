import { describe, expect, it } from "vitest";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import { evaluateEligibility } from "../../src/modules/policy/application/warmup-eligibility-policy.js";
import type { RiskAssessment } from "../../src/modules/risk/domain/risk-assessment.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function health(overrides: Partial<MailboxHealthAssessment> = {}): MailboxHealthAssessment {
  return {
    connection: "HEALTHY",
    authentication: "HEALTHY",
    sending: "HEALTHY",
    receiving: "HEALTHY",
    domain: "HEALTHY",
    configuration: "HEALTHY",
    assessedAt: NOW,
    ...overrides,
  };
}

function risk(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: NOW, ...overrides };
}

describe("evaluateEligibility", () => {
  it("is deterministic", () => {
    const input = { health: health(), risk: risk(), mailboxEnabled: true };
    expect(evaluateEligibility(input, NOW)).toEqual(evaluateEligibility(input, NOW));
  });

  it("is ELIGIBLE for a fully healthy, low-risk, enabled mailbox", () => {
    const result = evaluateEligibility({ health: health(), risk: risk(), mailboxEnabled: true }, NOW);
    expect(result.decision).toBe("ELIGIBLE");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("requires review when core health has not yet been measured", () => {
    const result = evaluateEligibility(
      { health: health({ connection: "UNKNOWN" }), risk: risk({ riskLevel: "UNKNOWN" }), mailboxEnabled: true },
      NOW,
    );
    expect(result.decision).toBe("REQUIRES_REVIEW");
  });

  it("is NOT_ELIGIBLE when disconnected", () => {
    const result = evaluateEligibility(
      { health: health({ connection: "UNHEALTHY" }), risk: risk({ riskLevel: "HIGH" }), mailboxEnabled: true },
      NOW,
    );
    expect(result.decision).toBe("NOT_ELIGIBLE");
    expect(result.reasons.some((r) => /disconnected/i.test(r))).toBe(true);
  });

  it("is NOT_ELIGIBLE when disabled, even if otherwise healthy", () => {
    const result = evaluateEligibility({ health: health(), risk: risk(), mailboxEnabled: false }, NOW);
    expect(result.decision).toBe("NOT_ELIGIBLE");
  });

  it("is NOT_ELIGIBLE when risk is CRITICAL", () => {
    const result = evaluateEligibility({ health: health(), risk: risk({ riskLevel: "CRITICAL" }), mailboxEnabled: true }, NOW);
    expect(result.decision).toBe("NOT_ELIGIBLE");
  });

  it("requires review (not an automatic NOT_ELIGIBLE) when risk is HIGH with no single blocker", () => {
    const result = evaluateEligibility({ health: health(), risk: risk({ riskLevel: "HIGH" }), mailboxEnabled: true }, NOW);
    expect(result.decision).toBe("REQUIRES_REVIEW");
  });

  it("is CONDITIONALLY_ELIGIBLE when domain authentication is incomplete but connectivity is healthy", () => {
    const result = evaluateEligibility(
      { health: health({ domain: "DEGRADED" }), risk: risk({ riskLevel: "LOW" }), mailboxEnabled: true },
      NOW,
    );
    expect(result.decision).toBe("CONDITIONALLY_ELIGIBLE");
    expect(result.reasons.some((r) => /domain/i.test(r))).toBe(true);
  });

  it("is CONDITIONALLY_ELIGIBLE at MEDIUM risk", () => {
    const result = evaluateEligibility({ health: health(), risk: risk({ riskLevel: "MEDIUM" }), mailboxEnabled: true }, NOW);
    expect(result.decision).toBe("CONDITIONALLY_ELIGIBLE");
  });

  it("always returns non-empty, explanatory reasons for every decision", () => {
    const decisions = [
      evaluateEligibility({ health: health(), risk: risk(), mailboxEnabled: true }, NOW),
      evaluateEligibility({ health: health({ connection: "UNHEALTHY" }), risk: risk(), mailboxEnabled: true }, NOW),
      evaluateEligibility({ health: health({ domain: "DEGRADED" }), risk: risk(), mailboxEnabled: true }, NOW),
      evaluateEligibility({ health: health({ connection: "UNKNOWN" }), risk: risk({ riskLevel: "UNKNOWN" }), mailboxEnabled: true }, NOW),
    ];
    for (const decision of decisions) {
      expect(decision.reasons.length).toBeGreaterThan(0);
      for (const reason of decision.reasons) {
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });
});

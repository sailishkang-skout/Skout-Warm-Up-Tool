import { describe, expect, it } from "vitest";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import { evaluateRisk } from "../../src/modules/risk/application/risk-policy.js";

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

describe("evaluateRisk", () => {
  it("is deterministic — the same input always produces the same output", () => {
    const input = { health: health({ connection: "UNHEALTHY" }), domainAssessed: true };
    const first = evaluateRisk(input, NOW);
    const second = evaluateRisk(input, NOW);
    expect(first).toEqual(second);
  });

  it("returns LOW risk with no factors for a fully healthy mailbox", () => {
    const result = evaluateRisk({ health: health(), domainAssessed: true }, NOW);
    expect(result.riskLevel).toBe("LOW");
    expect(result.riskScore).toBe(0);
    expect(result.riskFactors).toEqual([]);
  });

  it("returns UNKNOWN when nothing has been measured yet", () => {
    const unmeasured = health({
      connection: "UNKNOWN",
      authentication: "UNKNOWN",
      sending: "UNKNOWN",
      receiving: "UNKNOWN",
      domain: "UNKNOWN",
    });
    const result = evaluateRisk({ health: unmeasured, domainAssessed: false }, NOW);
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.riskFactors).toEqual([]);
  });

  it("raises risk level as more factors are triggered, in order", () => {
    const disconnected = evaluateRisk({ health: health({ connection: "UNHEALTHY" }), domainAssessed: true }, NOW);
    expect(disconnected.riskLevel).toBe("HIGH");
    expect(disconnected.riskFactors.map((f) => f.code)).toContain("PROVIDER_DISCONNECTED");

    const disconnectedAndUnauthenticated = evaluateRisk(
      { health: health({ connection: "UNHEALTHY", authentication: "UNHEALTHY" }), domainAssessed: true },
      NOW,
    );
    expect(disconnectedAndUnauthenticated.riskLevel).toBe("CRITICAL");
    expect(disconnectedAndUnauthenticated.riskScore).toBeGreaterThan(disconnected.riskScore);
  });

  it("caps the score at 100 even when every factor triggers", () => {
    const everythingBroken = health({
      connection: "UNHEALTHY",
      authentication: "UNHEALTHY",
      sending: "UNHEALTHY",
      receiving: "UNHEALTHY",
      domain: "UNHEALTHY",
      configuration: "DEGRADED",
    });
    const result = evaluateRisk({ health: everythingBroken, domainAssessed: true }, NOW);
    expect(result.riskScore).toBeLessThanOrEqual(100);
    expect(result.riskLevel).toBe("CRITICAL");
  });

  it("does not evaluate domain-related factors when no domain assessment was made", () => {
    const result = evaluateRisk({ health: health({ domain: "UNHEALTHY" }), domainAssessed: false }, NOW);
    expect(result.riskFactors.some((f) => f.code === "MISSING_MX")).toBe(false);
  });

  it("flags a disabled mailbox as a medium-weight risk factor", () => {
    const result = evaluateRisk({ health: health({ configuration: "DEGRADED" }), domainAssessed: true }, NOW);
    expect(result.riskFactors.map((f) => f.code)).toContain("MAILBOX_DISABLED");
  });

  it("every risk factor description is a safe, human-readable string (no raw error leakage)", () => {
    const result = evaluateRisk(
      { health: health({ connection: "UNHEALTHY", authentication: "UNHEALTHY" }), domainAssessed: true },
      NOW,
    );
    for (const f of result.riskFactors) {
      expect(f.description.length).toBeGreaterThan(0);
      expect(f.description).not.toMatch(/at Object|node_modules|stack/i);
    }
  });
});

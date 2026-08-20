import { describe, expect, it } from "vitest";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import { evaluateRisk } from "../../src/modules/risk/application/risk-policy.js";
import type { ReputationAssessment, ReputationFactor } from "../../src/modules/reputation/domain/reputation-assessment.js";
import { asMailboxId, asReputationAssessmentId, asTenantId } from "../../src/shared/types/index.js";

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

const EMPTY_WINDOW = {
  eventCount: 0,
  deliveryRate: "UNKNOWN" as const,
  bounceRate: "UNKNOWN" as const,
  hardBounceRate: "UNKNOWN" as const,
  softBounceRate: "UNKNOWN" as const,
  throttleRate: "UNKNOWN" as const,
  rejectionRate: "UNKNOWN" as const,
  failureRate: "UNKNOWN" as const,
  complaintRate: "UNKNOWN" as const,
  unknownRate: "UNKNOWN" as const,
};

const STABLE_TRENDS = { delivery: "STABLE", bounce: "STABLE", throttle: "STABLE", failure: "STABLE", complaint: "STABLE" } as const;

function providerReputation(factors: ReputationFactor[] = [], status: ReputationAssessment["status"] = "UNKNOWN"): ReputationAssessment["providerReputation"] {
  return { provider: "GMAIL", status, confidence: "HIGH", factors, trends: STABLE_TRENDS, last24h: EMPTY_WINDOW, last7d: EMPTY_WINDOW, lifetime: { ...EMPTY_WINDOW, eventCount: 100 } };
}

function domainReputation(factors: ReputationFactor[] = [], status: ReputationAssessment["status"] = "UNKNOWN"): ReputationAssessment["domainReputation"] {
  return {
    domain: "example.com",
    status,
    confidence: "HIGH",
    factors,
    trends: STABLE_TRENDS,
    last24h: EMPTY_WINDOW,
    last7d: EMPTY_WINDOW,
    lifetime: { ...EMPTY_WINDOW, eventCount: 100 },
    authentication: { mx: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
  };
}

function reputation(
  factors: ReputationFactor[] = [],
  status: ReputationAssessment["status"] = "HEALTHY",
  overrides: Partial<Pick<ReputationAssessment, "providerReputation" | "domainReputation">> = {},
): ReputationAssessment {
  return {
    id: asReputationAssessmentId("11111111-1111-1111-1111-111111111111"),
    tenantId: asTenantId("22222222-2222-2222-2222-222222222222"),
    mailboxId: asMailboxId("33333333-3333-3333-3333-333333333333"),
    status,
    confidence: "HIGH",
    factors,
    trends: STABLE_TRENDS,
    last24h: EMPTY_WINDOW,
    last7d: EMPTY_WINDOW,
    lifetime: { ...EMPTY_WINDOW, eventCount: 100 },
    providerReputation: providerReputation(),
    domainReputation: domainReputation(),
    assessedAt: NOW,
    createdAt: NOW,
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

  describe("reputation integration (Stage 10)", () => {
    it("omitting reputation entirely behaves exactly as before (backward compatible)", () => {
      const withReputation = evaluateRisk({ health: health(), domainAssessed: true, reputation: reputation([]) }, NOW);
      const without = evaluateRisk({ health: health(), domainAssessed: true }, NOW);
      expect(withReputation).toEqual(without);
    });

    it("a HIGH_BOUNCE_RATE reputation factor is re-weighted into the risk score", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([{ code: "HIGH_BOUNCE_RATE", description: "Bounce rate is elevated (high) over the last 24 hours.", severity: "HIGH" }]),
        },
        NOW,
      );
      expect(result.riskFactors.map((f) => f.code)).toContain("HIGH_BOUNCE_RATE");
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it("a single reputation factor never alone reaches CRITICAL risk (evidence-gated)", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([{ code: "COMPLAINT_SIGNAL", description: "6 complaint(s) observed in the last 24 hours.", severity: "CRITICAL" }]),
        },
        NOW,
      );
      expect(result.riskLevel).not.toBe("CRITICAL");
    });

    it("multiple corroborating reputation factors can combine to reach CRITICAL", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([
            { code: "COMPLAINT_SIGNAL", description: "6 complaint(s) observed.", severity: "CRITICAL" },
            { code: "HIGH_BOUNCE_RATE", description: "Bounce rate is elevated.", severity: "CRITICAL" },
            { code: "DEGRADING_DELIVERY_TREND", description: "Delivery is trending down.", severity: "MEDIUM" },
          ]),
        },
        NOW,
      );
      expect(result.riskLevel).toBe("CRITICAL");
    });

    it("ignores an unrecognized factor code from reputation rather than crashing", () => {
      const result = evaluateRisk(
        { health: health(), domainAssessed: true, reputation: reputation([{ code: "SOME_FUTURE_CODE", description: "future", severity: "HIGH" }]) },
        NOW,
      );
      expect(result.riskFactors.map((f) => f.code)).not.toContain("SOME_FUTURE_CODE");
    });

    it("reputation with real evidence keeps risk out of UNKNOWN even when health itself is entirely unmeasured", () => {
      const unmeasured = health({ connection: "UNKNOWN", authentication: "UNKNOWN", sending: "UNKNOWN", receiving: "UNKNOWN", domain: "UNKNOWN" });
      const result = evaluateRisk(
        {
          health: unmeasured,
          domainAssessed: false,
          reputation: reputation([{ code: "HIGH_BOUNCE_RATE", description: "Bounce rate is elevated.", severity: "MEDIUM" }], "DEGRADED"),
        },
        NOW,
      );
      expect(result.riskLevel).not.toBe("UNKNOWN");
    });

    it("an UNKNOWN-status reputation with no factors does not itself change an otherwise-healthy risk result", () => {
      const result = evaluateRisk({ health: health(), domainAssessed: true, reputation: reputation([], "UNKNOWN") }, NOW);
      expect(result.riskLevel).toBe("LOW");
      expect(result.riskScore).toBe(0);
    });
  });

  describe("provider/domain reputation integration (Stage 11)", () => {
    it("a PROVIDER_HIGH_BOUNCE_RATE factor is re-weighted into the risk score", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([], "HEALTHY", {
            providerReputation: providerReputation([{ code: "PROVIDER_HIGH_BOUNCE_RATE", description: "Provider-wide bounce rate is elevated.", severity: "HIGH" }], "POOR"),
          }),
        },
        NOW,
      );
      expect(result.riskFactors.map((f) => f.code)).toContain("PROVIDER_HIGH_BOUNCE_RATE");
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it("a DOMAIN_COMPLAINT_SIGNAL factor is re-weighted into the risk score", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([], "HEALTHY", {
            domainReputation: domainReputation([{ code: "DOMAIN_COMPLAINT_SIGNAL", description: "6 complaint(s) observed for this domain.", severity: "CRITICAL" }], "CRITICAL"),
          }),
        },
        NOW,
      );
      expect(result.riskFactors.map((f) => f.code)).toContain("DOMAIN_COMPLAINT_SIGNAL");
    });

    it("a single provider or domain reputation factor never alone reaches CRITICAL risk, even at CRITICAL severity", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([], "HEALTHY", {
            providerReputation: providerReputation([{ code: "PROVIDER_COMPLAINT_SIGNAL", description: "Provider-wide complaints.", severity: "CRITICAL" }], "CRITICAL"),
          }),
        },
        NOW,
      );
      expect(result.riskLevel).not.toBe("CRITICAL");
    });

    it("a mailbox with a perfectly clean own history still sees elevated risk from a struggling provider/domain", () => {
      const clean = evaluateRisk({ health: health(), domainAssessed: true, reputation: reputation([], "EXCELLENT") }, NOW);
      const withProviderProblem = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation([], "EXCELLENT", {
            providerReputation: providerReputation([{ code: "PROVIDER_HIGH_BOUNCE_RATE", description: "Provider-wide bounce rate is elevated.", severity: "HIGH" }], "POOR"),
          }),
        },
        NOW,
      );
      expect(withProviderProblem.riskScore).toBeGreaterThan(clean.riskScore);
    });

    it("multiple corroborating mailbox + provider + domain factors can combine to reach CRITICAL", () => {
      const result = evaluateRisk(
        {
          health: health(),
          domainAssessed: true,
          reputation: reputation(
            [
              { code: "COMPLAINT_SIGNAL", description: "Mailbox complaints.", severity: "CRITICAL" },
              { code: "HIGH_BOUNCE_RATE", description: "Mailbox bounce rate.", severity: "CRITICAL" },
            ],
            "CRITICAL",
            {
              providerReputation: providerReputation([{ code: "PROVIDER_HIGH_THROTTLE_RATE", description: "Provider-wide throttling.", severity: "HIGH" }], "POOR"),
              domainReputation: domainReputation([{ code: "DOMAIN_HIGH_FAILURE_RATE", description: "Domain-wide failures.", severity: "HIGH" }], "POOR"),
            },
          ),
        },
        NOW,
      );
      expect(result.riskLevel).toBe("CRITICAL");
    });

    it("provider reputation with real evidence keeps risk out of UNKNOWN even when health and mailbox reputation are both unmeasured", () => {
      const unmeasured = health({ connection: "UNKNOWN", authentication: "UNKNOWN", sending: "UNKNOWN", receiving: "UNKNOWN", domain: "UNKNOWN" });
      const result = evaluateRisk(
        {
          health: unmeasured,
          domainAssessed: false,
          reputation: reputation([], "UNKNOWN", {
            providerReputation: providerReputation([{ code: "PROVIDER_HIGH_BOUNCE_RATE", description: "Provider-wide bounce rate.", severity: "MEDIUM" }], "DEGRADED"),
          }),
        },
        NOW,
      );
      expect(result.riskLevel).not.toBe("UNKNOWN");
    });

    it("everything UNKNOWN (health, mailbox, provider, domain) still returns UNKNOWN risk, never a fabricated LOW", () => {
      const unmeasured = health({ connection: "UNKNOWN", authentication: "UNKNOWN", sending: "UNKNOWN", receiving: "UNKNOWN", domain: "UNKNOWN" });
      const result = evaluateRisk({ health: unmeasured, domainAssessed: false, reputation: reputation([], "UNKNOWN") }, NOW);
      expect(result.riskLevel).toBe("UNKNOWN");
    });
  });
});

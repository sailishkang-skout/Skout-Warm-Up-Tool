import { describe, expect, it } from "vitest";
import { evaluateReputation, type ReputationPolicyInput } from "../../src/modules/reputation/application/reputation-policy.js";
import type { DeliveryEventCounts } from "../../src/modules/delivery-events/application/delivery-event-repository.js";

function counts(overrides: Partial<DeliveryEventCounts> = {}): DeliveryEventCounts {
  return {
    DELIVERED: 0,
    BOUNCED: 0,
    FAILED: 0,
    THROTTLED: 0,
    DEFERRED: 0,
    REJECTED: 0,
    COMPLAINT: 0,
    UNKNOWN: 0,
    ...overrides,
  };
}

const EMPTY = counts();

function input(overrides: Partial<ReputationPolicyInput> = {}): ReputationPolicyInput {
  return {
    last24h: EMPTY,
    prior24h: EMPTY,
    last7d: EMPTY,
    lifetime: EMPTY,
    ...overrides,
  };
}

describe("evaluateReputation", () => {
  it("is deterministic — the same input always produces the same output", () => {
    const i = input({ last24h: counts({ DELIVERED: 20, BOUNCED: 2 }), lifetime: counts({ DELIVERED: 20, BOUNCED: 2 }) });
    expect(evaluateReputation(i)).toEqual(evaluateReputation(i));
  });

  describe("UNKNOWN semantics", () => {
    it("every rate is UNKNOWN, never a fabricated 0, when a window has too few events", () => {
      const result = evaluateReputation(input({ last24h: counts({ BOUNCED: 1 }), lifetime: counts({ BOUNCED: 1 }) }));
      expect(result.last24h.eventCount).toBe(1);
      expect(result.last24h.bounceRate).toBe("UNKNOWN");
      expect(result.last24h.deliveryRate).toBe("UNKNOWN");
      expect(result.last24h.complaintRate).toBe("UNKNOWN");
    });

    it("status is UNKNOWN when there is no lifetime evidence at all and nothing triggered", () => {
      const result = evaluateReputation(input());
      expect(result.status).toBe("UNKNOWN");
      expect(result.confidence).toBe("LOW");
    });

    it("hardBounceRate is always UNKNOWN — this system's event taxonomy has no hard/soft bounce split", () => {
      const result = evaluateReputation(input({ last24h: counts({ DELIVERED: 20, BOUNCED: 20 }), lifetime: counts({ DELIVERED: 20, BOUNCED: 20 }) }));
      expect(result.last24h.hardBounceRate).toBe("UNKNOWN");
      expect(result.lifetime.hardBounceRate).toBe("UNKNOWN");
    });

    it("trends are UNKNOWN, never derived from a single isolated event, when either side lacks enough sample", () => {
      const result = evaluateReputation(input({ last24h: counts({ DELIVERED: 1, BOUNCED: 1 }), prior24h: EMPTY, lifetime: counts({ DELIVERED: 1, BOUNCED: 1 }) }));
      expect(result.trends.bounce).toBe("UNKNOWN");
      expect(result.trends.delivery).toBe("UNKNOWN");
    });

    it("a real, genuine complaint is never suppressed by insufficient overall sample size", () => {
      // Only 1 event ever observed, and it's a complaint.
      const result = evaluateReputation(input({ last24h: counts({ COMPLAINT: 1 }), lifetime: counts({ COMPLAINT: 1 }) }));
      expect(result.factors.map((f) => f.code)).toContain("COMPLAINT_SIGNAL");
      expect(result.status).not.toBe("UNKNOWN");
    });
  });

  describe("rate thresholds and factors", () => {
    it("no factors and HEALTHY status for a mailbox with a clean but not-yet-EXCELLENT-sized history", () => {
      const clean = counts({ DELIVERED: 15 }); // below EXCELLENT_MIN_SAMPLE (20)
      const result = evaluateReputation(input({ last24h: clean, last7d: clean, lifetime: clean }));
      expect(result.factors).toEqual([]);
      expect(result.status).toBe("HEALTHY");
    });

    it("EXCELLENT requires both a very high delivery rate and a real sample size", () => {
      const excellent = counts({ DELIVERED: 25 });
      const result = evaluateReputation(input({ last24h: EMPTY, last7d: excellent, lifetime: excellent }));
      expect(result.status).toBe("EXCELLENT");
    });

    it("does not grant EXCELLENT status on a small sample even with a perfect delivery rate", () => {
      const small = counts({ DELIVERED: 6 });
      const result = evaluateReputation(input({ last7d: small, lifetime: small }));
      expect(result.status).not.toBe("EXCELLENT");
    });

    it("elevated bounce rate produces a HIGH_BOUNCE_RATE factor and a DEGRADED/POOR status", () => {
      const bouncy = counts({ DELIVERED: 8, BOUNCED: 2 }); // 20% bounce
      const result = evaluateReputation(input({ last24h: bouncy, lifetime: bouncy }));
      expect(result.factors.map((f) => f.code)).toContain("HIGH_BOUNCE_RATE");
      expect(["DEGRADED", "POOR", "CRITICAL"]).toContain(result.status);
    });

    it("a single isolated bad event lost in an otherwise large clean sample never triggers a factor (noise, not evidence)", () => {
      const mostlyClean = counts({ DELIVERED: 199, BOUNCED: 1 }); // 0.5% bounce
      const result = evaluateReputation(input({ last24h: mostlyClean, lifetime: mostlyClean }));
      expect(result.factors.map((f) => f.code)).not.toContain("HIGH_BOUNCE_RATE");
      expect(result.status).not.toBe("CRITICAL");
    });

    it("a genuinely severe, well-sampled rate (not one noisy event) is allowed to reach CRITICAL reputation status", () => {
      const catastrophic = counts({ DELIVERED: 2, BOUNCED: 18 }); // 90% bounce across 20 real events
      const result = evaluateReputation(input({ last24h: catastrophic, lifetime: catastrophic }));
      expect(result.status).toBe("CRITICAL");
    });

    it("complaints are gated by absolute count, not rate — a single complaint out of many events is still flagged, but only at MEDIUM", () => {
      const large = counts({ DELIVERED: 199, COMPLAINT: 1 });
      const result = evaluateReputation(input({ last24h: large, lifetime: large }));
      const complaintFactor = result.factors.find((f) => f.code === "COMPLAINT_SIGNAL");
      expect(complaintFactor?.severity).toBe("MEDIUM");
    });

    it("throttle/rejection/failure rates each produce their own distinct factor code", () => {
      const throttled = evaluateReputation(input({ last24h: counts({ DELIVERED: 8, THROTTLED: 4 }), lifetime: counts({ DELIVERED: 8, THROTTLED: 4 }) }));
      expect(throttled.factors.map((f) => f.code)).toContain("HIGH_THROTTLE_RATE");

      const rejected = evaluateReputation(input({ last24h: counts({ DELIVERED: 8, REJECTED: 3 }), lifetime: counts({ DELIVERED: 8, REJECTED: 3 }) }));
      expect(rejected.factors.map((f) => f.code)).toContain("HIGH_PROVIDER_REJECTION_RATE");

      const failed = evaluateReputation(input({ last24h: counts({ DELIVERED: 8, FAILED: 3 }), lifetime: counts({ DELIVERED: 8, FAILED: 3 }) }));
      expect(failed.factors.map((f) => f.code)).toContain("HIGH_FAILURE_RATE");
    });
  });

  describe("trend detection", () => {
    it("detects a DEGRADING bounce trend when the recent window is meaningfully worse than the prior one", () => {
      const priorClean = counts({ DELIVERED: 20 });
      const recentBouncy = counts({ DELIVERED: 12, BOUNCED: 8 }); // 40% bounce vs 0% prior
      const result = evaluateReputation(input({ last24h: recentBouncy, prior24h: priorClean, lifetime: counts({ DELIVERED: 32, BOUNCED: 8 }) }));
      expect(result.trends.bounce).toBe("DEGRADING");
      expect(result.factors.map((f) => f.code)).toContain("DEGRADING_BOUNCE_TREND");
    });

    it("detects an IMPROVING delivery trend when the recent window is meaningfully better", () => {
      const priorBad = counts({ DELIVERED: 10, FAILED: 10 });
      const recentGood = counts({ DELIVERED: 19, FAILED: 1 });
      const result = evaluateReputation(input({ last24h: recentGood, prior24h: priorBad, lifetime: counts({ DELIVERED: 29, FAILED: 11 }) }));
      expect(result.trends.delivery).toBe("IMPROVING");
    });

    it("a small, noisy difference between windows is STABLE, not a trend", () => {
      const a = counts({ DELIVERED: 19, BOUNCED: 1 });
      const b = counts({ DELIVERED: 18, BOUNCED: 2 });
      const result = evaluateReputation(input({ last24h: a, prior24h: b, lifetime: counts({ DELIVERED: 37, BOUNCED: 3 }) }));
      expect(result.trends.bounce).toBe("STABLE");
    });
  });

  describe("confidence", () => {
    it("LOW confidence for a small lifetime sample", () => {
      const result = evaluateReputation(input({ lifetime: counts({ DELIVERED: 8 }) }));
      expect(result.confidence).toBe("LOW");
    });

    it("MEDIUM confidence for a moderate lifetime sample", () => {
      const result = evaluateReputation(input({ lifetime: counts({ DELIVERED: 25 }) }));
      expect(result.confidence).toBe("MEDIUM");
    });

    it("HIGH confidence for a large lifetime sample", () => {
      const result = evaluateReputation(input({ lifetime: counts({ DELIVERED: 80 }) }));
      expect(result.confidence).toBe("HIGH");
    });
  });

  it("factors are derived from the most recent (last-24h) window, not lifetime totals that could mask a recent problem", () => {
    const longHealthyHistory = counts({ DELIVERED: 500 });
    const recentProblem = counts({ DELIVERED: 5, BOUNCED: 5 }); // 50% bounce right now
    const result = evaluateReputation(input({ last24h: recentProblem, lifetime: counts({ DELIVERED: 505, BOUNCED: 5 }) }));
    expect(result.factors.map((f) => f.code)).toContain("HIGH_BOUNCE_RATE");
    void longHealthyHistory;
  });
});

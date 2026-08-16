import { describe, expect, it } from "vitest";
import { detectChanges } from "../../src/modules/health/domain/assessment-change.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import { asHealthSnapshotId, asMailboxId, asTenantId } from "../../src/shared/types/index.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function snapshot(overrides: Partial<AssessmentSnapshot> = {}): AssessmentSnapshot {
  return {
    id: asHealthSnapshotId("11111111-1111-1111-1111-111111111111"),
    tenantId: asTenantId("22222222-2222-2222-2222-222222222222"),
    mailboxId: asMailboxId("33333333-3333-3333-3333-333333333333"),
    health: {
      connection: "HEALTHY",
      authentication: "HEALTHY",
      sending: "HEALTHY",
      receiving: "HEALTHY",
      domain: "HEALTHY",
      configuration: "HEALTHY",
      assessedAt: NOW,
    },
    risk: { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: NOW },
    eligibility: { decision: "ELIGIBLE", reasons: ["ok"], assessedAt: NOW },
    capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 5, maximumDailyVolume: 20, confidence: "HIGH", reasons: ["ok"], assessedAt: NOW },
    assessedAt: NOW,
    ...overrides,
  };
}

describe("detectChanges", () => {
  it("returns no changes when there is no previous snapshot (first assessment)", () => {
    expect(detectChanges(undefined, snapshot())).toEqual([]);
  });

  it("returns no changes between two identical snapshots", () => {
    expect(detectChanges(snapshot(), snapshot())).toEqual([]);
  });

  it("detects a risk level change", () => {
    const previous = snapshot();
    const current = snapshot({ risk: { riskLevel: "HIGH", riskScore: 50, riskFactors: [], assessedAt: NOW } });
    const changes = detectChanges(previous, current);
    expect(changes).toContainEqual({ field: "riskLevel", previousValue: "LOW", newValue: "HIGH" });
  });

  it("detects an eligibility decision change", () => {
    const previous = snapshot();
    const current = snapshot({ eligibility: { decision: "NOT_ELIGIBLE", reasons: ["disconnected"], assessedAt: NOW } });
    const changes = detectChanges(previous, current);
    expect(changes).toContainEqual({ field: "eligibilityDecision", previousValue: "ELIGIBLE", newValue: "NOT_ELIGIBLE" });
  });

  it("detects a connection health change (connected -> disconnected)", () => {
    const previous = snapshot();
    const current = snapshot({
      health: { ...previous.health, connection: "UNHEALTHY" },
    });
    const changes = detectChanges(previous, current);
    expect(changes).toContainEqual({ field: "health.connection", previousValue: "HEALTHY", newValue: "UNHEALTHY" });
  });

  it("detects domain authentication changes when both snapshots have a domain assessment (DMARC PASS -> FAIL)", () => {
    const domainAssessment = {
      domain: "example.com",
      mx: { status: "PASS" as const, records: ["mx1.example.com"] },
      spf: { status: "PASS" as const, record: "v=spf1 -all" },
      dkim: { status: "MISSING" as const },
      dmarc: { status: "PASS" as const, policy: "reject" as const, record: "v=DMARC1; p=reject" },
      checkedAt: NOW,
    };
    const previous = snapshot({ domainAssessment });
    const current = snapshot({
      domainAssessment: { ...domainAssessment, dmarc: { status: "FAIL", record: "v=DMARC1; p=reject; p=reject" } },
    });
    const changes = detectChanges(previous, current);
    expect(changes).toContainEqual({ field: "domain.dmarc", previousValue: "PASS", newValue: "FAIL" });
  });

  it("does not compare domain fields when either snapshot lacks a domain assessment", () => {
    const previous = snapshot();
    const current = snapshot();
    expect(detectChanges(previous, current).some((c) => c.field.startsWith("domain."))).toBe(false);
  });

  it("returns multiple changes when several fields differ at once", () => {
    const previous = snapshot();
    const current = snapshot({
      risk: { riskLevel: "CRITICAL", riskScore: 90, riskFactors: [], assessedAt: NOW },
      eligibility: { decision: "NOT_ELIGIBLE", reasons: ["x"], assessedAt: NOW },
      health: { ...previous.health, connection: "UNHEALTHY", authentication: "UNHEALTHY" },
    });
    const changes = detectChanges(previous, current);
    expect(changes.length).toBeGreaterThanOrEqual(4);
  });
});

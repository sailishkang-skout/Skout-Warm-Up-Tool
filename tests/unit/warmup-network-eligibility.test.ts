import { describe, expect, it } from "vitest";
import {
  classifyEmptyPoolFailure,
  evaluateWarmupDomainEligibility,
  evaluateWarmupMailboxEligibility,
  isWarmupDomainEligible,
  isWarmupMailboxEligible,
} from "../../src/modules/warmup-network/application/warmup-network-eligibility.js";
import type { WarmupNetworkDomain } from "../../src/modules/warmup-network/domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../../src/modules/warmup-network/domain/warmup-network-mailbox.js";
import {
  asMailboxId,
  asWarmupNetworkDomainId,
  asWarmupNetworkId,
  asWarmupNetworkMailboxId,
  asWarmupNetworkPoolId,
} from "../../src/shared/types/index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const CONFIG = { minHealthScore: 50, requireSpf: true, requireDkim: true, requireDmarc: true };

function domain(overrides: Partial<WarmupNetworkDomain> = {}): WarmupNetworkDomain {
  return {
    id: asWarmupNetworkDomainId("11111111-1111-1111-1111-111111111111"),
    networkId: asWarmupNetworkId("22222222-2222-2222-2222-222222222222"),
    poolId: asWarmupNetworkPoolId("33333333-3333-3333-3333-333333333333"),
    domain: "skout-warmup.test",
    provider: "GMAIL",
    status: "ACTIVE",
    authenticationStatus: "PASS",
    spfStatus: "PASS",
    dkimStatus: "PASS",
    dmarcStatus: "PASS",
    reputationStatus: "HEALTHY",
    healthScore: 80,
    capacityStatus: "AVAILABLE",
    dailyCapacity: 50,
    usageDate: "2026-08-19",
    usageCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mailbox(overrides: Partial<WarmupNetworkMailbox> = {}): WarmupNetworkMailbox {
  return {
    id: asWarmupNetworkMailboxId("44444444-4444-4444-4444-444444444444"),
    domainId: asWarmupNetworkDomainId("11111111-1111-1111-1111-111111111111"),
    poolId: asWarmupNetworkPoolId("33333333-3333-3333-3333-333333333333"),
    mailboxId: asMailboxId("55555555-5555-5555-5555-555555555555"),
    provider: "GMAIL",
    providerMailboxIdentifier: "partner@skout-warmup.test",
    mailboxAddress: "partner@skout-warmup.test",
    status: "ACTIVE",
    healthScore: 80,
    reputationState: "HEALTHY",
    dailyCapacity: 50,
    usageDate: "2026-08-19",
    usageCount: 0,
    credentialAvailable: true,
    membershipStatus: "ACTIVE",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const linked = { status: "CONNECTED" as const, enabled: true };

describe("warmup network domain eligibility", () => {
  it("accepts an active authenticated domain with remaining capacity", () => {
    expect(isWarmupDomainEligible(domain(), NOW, CONFIG)).toBe(true);
  });

  it("rejects DEGRADED, QUARANTINED, and DISABLED status", () => {
    expect(isWarmupDomainEligible(domain({ status: "DEGRADED" }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ status: "QUARANTINED" }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ status: "DISABLED" }), NOW, CONFIG)).toBe(false);
  });

  it("rejects cooldown when cooldown_until is in the future", () => {
    expect(isWarmupDomainEligible(domain({ cooldownUntil: new Date("2026-08-19T13:00:00.000Z") }), NOW, CONFIG)).toBe(false);
  });

  it("rejects missing SPF/DKIM/DMARC when required", () => {
    expect(isWarmupDomainEligible(domain({ spfStatus: "MISSING" }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ dkimStatus: "FAIL" }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ dmarcStatus: "UNKNOWN" }), NOW, CONFIG)).toBe(false);
  });

  it("rejects health below threshold, exhausted capacity, and POOR/CRITICAL reputation", () => {
    expect(isWarmupDomainEligible(domain({ healthScore: 49 }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ usageCount: 50 }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ reputationStatus: "POOR" }), NOW, CONFIG)).toBe(false);
    expect(isWarmupDomainEligible(domain({ reputationStatus: "CRITICAL" }), NOW, CONFIG)).toBe(false);
  });

  it("resets capacity against today's UTC date", () => {
    expect(isWarmupDomainEligible(domain({ usageDate: "2026-08-18", usageCount: 50 }), NOW, CONFIG)).toBe(true);
  });
});

describe("warmup network mailbox eligibility", () => {
  it("requires an eligible parent domain", () => {
    expect(isWarmupMailboxEligible(mailbox(), domain({ status: "QUARANTINED" }), NOW, CONFIG, linked)).toBe(false);
  });

  it("rejects unsupported provider, missing credential, cooldown, and quarantine", () => {
    expect(isWarmupMailboxEligible(mailbox({ credentialAvailable: false }), domain(), NOW, CONFIG, linked)).toBe(false);
    expect(isWarmupMailboxEligible(mailbox({ status: "QUARANTINED" }), domain(), NOW, CONFIG, linked)).toBe(false);
    expect(
      isWarmupMailboxEligible(mailbox({ cooldownUntil: new Date("2026-08-20T00:00:00.000Z") }), domain(), NOW, CONFIG, linked),
    ).toBe(false);
  });

  it("rejects a linked mailbox that is not CONNECTED and enabled", () => {
    expect(isWarmupMailboxEligible(mailbox(), domain(), NOW, CONFIG, { status: "DISCONNECTED", enabled: true })).toBe(false);
    expect(isWarmupMailboxEligible(mailbox(), domain(), NOW, CONFIG, { status: "CONNECTED", enabled: false })).toBe(false);
  });

  it("rejects exhausted mailbox capacity even when the parent domain has remaining capacity", () => {
    expect(isWarmupMailboxEligible(mailbox({ usageCount: 50, dailyCapacity: 50 }), domain(), NOW, CONFIG, linked)).toBe(false);
  });

  it("classifies capacity-only ineligibility as temporary", () => {
    const evaluation = evaluateWarmupDomainEligibility(domain({ usageCount: 50 }), NOW, CONFIG);
    expect(classifyEmptyPoolFailure([evaluation])).toEqual({ reason: "CAPACITY_EXHAUSTED", failureClass: "TEMPORARY" });
  });

  it("classifies an empty pool as permanent", () => {
    expect(classifyEmptyPoolFailure([])).toEqual({ reason: "EMPTY_POOL", failureClass: "PERMANENT" });
  });

  it("classifies parent-domain capacity exhaustion as temporary", () => {
    const evaluation = evaluateWarmupMailboxEligibility(
      mailbox(),
      domain({ usageCount: 50, dailyCapacity: 50 }),
      NOW,
      CONFIG,
      linked,
    );
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasons).toContain("PARENT_DOMAIN_INELIGIBLE");
    expect(evaluation.reasons).toContain("CAPACITY_EXHAUSTED");
    expect(classifyEmptyPoolFailure([evaluation])).toEqual({ reason: "CAPACITY_EXHAUSTED", failureClass: "TEMPORARY" });
  });

  it("classifies COOLDOWN status as temporary", () => {
    const evaluation = evaluateWarmupMailboxEligibility(mailbox({ status: "COOLDOWN" }), domain(), NOW, CONFIG, linked);
    expect(evaluation.reasons).toContain("IN_COOLDOWN");
    expect(evaluation.reasons).not.toContain("STATUS_NOT_ACTIVE");
    expect(classifyEmptyPoolFailure([evaluation])).toEqual({ reason: "COOLDOWN", failureClass: "TEMPORARY" });
  });

  it("rejects non-ACTIVE network membership", () => {
    const evaluation = evaluateWarmupMailboxEligibility(
      mailbox({ membershipStatus: "PAUSED" }),
      domain(),
      NOW,
      CONFIG,
      linked,
    );
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reasons).toContain("MEMBERSHIP_NOT_ACTIVE");
  });
});

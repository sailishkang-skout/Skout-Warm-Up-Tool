import { describe, expect, it } from "vitest";
import { deriveDomainHealth } from "../../src/modules/warmup-pool/domain/derived-domain-health.js";
import type { WarmupPool } from "../../src/modules/warmup-pool/domain/warmup-pool.js";
import type { WarmupPoolMembership } from "../../src/modules/warmup-pool/domain/warmup-pool-membership.js";
import {
  applyDomainDiversityFilter,
  compareByStrategy,
  evaluatePoolMembershipEligibility,
  selectEligibleMailbox,
  type WarmupPoolCandidate,
} from "../../src/modules/warmup-pool/application/warmup-pool-eligibility.js";
import { asMailboxId, asTenantId, asWarmupPoolId, asWarmupPoolMembershipId } from "../../src/shared/types/index.js";

const tenantId = asTenantId("00000000-0000-4000-8000-000000000001");
const poolId = asWarmupPoolId("00000000-0000-4000-8000-000000000010");
const now = new Date("2026-08-19T12:00:00.000Z");

function pool(overrides: Partial<WarmupPool> = {}): WarmupPool {
  return {
    id: poolId,
    tenantId,
    name: "default",
    status: "ACTIVE",
    strategy: "HEALTH_FIRST_LEAST_USED",
    maxConsecutiveSameDomain: 2,
    maxDomainSharePercent: 70,
    consecutiveSameDomain: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function membership(id: string, overrides: Partial<WarmupPoolMembership> = {}): WarmupPoolMembership {
  return {
    id: asWarmupPoolMembershipId(id),
    poolId,
    mailboxId: asMailboxId(id),
    tenantId,
    status: "AVAILABLE",
    priority: 0,
    weight: 1,
    currentDailyWarmupVolume: 0,
    usageDate: "2026-08-19",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function candidate(id: string, overrides: Partial<WarmupPoolCandidate> & { domain?: string } = {}): WarmupPoolCandidate {
  const { domain, membership: membershipOverride, ...rest } = overrides;
  return {
    membership: membershipOverride ?? membership(id),
    mailboxStatus: "CONNECTED",
    mailboxEnabled: true,
    emailDomain: domain ?? "one.test",
    credentialAvailable: true,
    providerAccountStatus: "ACTIVE",
    connectionHealth: "HEALTHY",
    authenticationHealth: "HEALTHY",
    sendingHealth: "HEALTHY",
    domainHealth: "HEALTHY",
    riskLevel: "LOW",
    reputationStatus: "HEALTHY",
    ...rest,
  };
}

describe("deriveDomainHealth", () => {
  it("is UNKNOWN when evidence is missing", () => {
    expect(deriveDomainHealth({})).toBe("UNKNOWN");
  });

  it("blocks unhealthy sending or critical risk", () => {
    expect(
      deriveDomainHealth({
        sendingHealth: "UNHEALTHY",
        connectionHealth: "HEALTHY",
        authenticationHealth: "HEALTHY",
        riskLevel: "LOW",
        reputationStatus: "HEALTHY",
      }),
    ).toBe("BLOCKED");
  });
});

describe("warmup pool eligibility", () => {
  it("skips disconnected, disabled, unhealthy, cooldown, capacity, and blocked risk", () => {
    const active = pool();
    expect(evaluatePoolMembershipEligibility(pool({ status: "PAUSED" }), candidate("a"), now).eligible).toBe(false);
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { mailboxStatus: "DISCONNECTED" }), now).reasons).toContain(
      "MAILBOX_DISCONNECTED",
    );
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { mailboxEnabled: false }), now).reasons).toContain(
      "MAILBOX_DISABLED",
    );
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { credentialAvailable: false }), now).reasons).toContain(
      "CREDENTIAL_UNAVAILABLE",
    );
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { sendingHealth: "UNHEALTHY" }), now).reasons).toContain(
      "MAILBOX_UNHEALTHY",
    );
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { riskLevel: "HIGH" }), now).reasons).toContain("RISK_BLOCKED");
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { reputationStatus: "POOR" }), now).reasons).toContain(
      "REPUTATION_BLOCKED",
    );
    expect(
      evaluatePoolMembershipEligibility(
        active,
        candidate("a", { membership: membership("a", { maxDailyWarmupVolume: 1, currentDailyWarmupVolume: 1 }) }),
        now,
      ).reasons,
    ).toContain("DAILY_CAPACITY_EXHAUSTED");
    expect(
      evaluatePoolMembershipEligibility(
        active,
        candidate("a", { membership: membership("a", { cooldownUntil: new Date("2026-08-19T13:00:00.000Z") }) }),
        now,
      ).reasons,
    ).toContain("IN_COOLDOWN");
    expect(evaluatePoolMembershipEligibility(active, candidate("a", { membership: membership("a", { status: "DISABLED" }) }), now).reasons).toContain(
      "MEMBERSHIP_DISABLED",
    );
  });

  it("keeps a single domain even when consecutive/share limits would otherwise skip", () => {
    const filtered = applyDomainDiversityFilter(
      [candidate("a", { domain: "only.test" }), candidate("b", { domain: "only.test" })],
      pool({ lastSelectedDomain: "only.test", consecutiveSameDomain: 9, maxConsecutiveSameDomain: 1 }),
      now,
    );
    expect(filtered.remaining).toHaveLength(2);
    expect(filtered.skipped).toHaveLength(0);
  });

  it("skips consecutive same-domain when another domain is eligible", () => {
    const filtered = applyDomainDiversityFilter(
      [candidate("a", { domain: "one.test" }), candidate("b", { domain: "two.test" })],
      pool({ lastSelectedDomain: "one.test", consecutiveSameDomain: 2, maxConsecutiveSameDomain: 2 }),
      now,
    );
    expect(filtered.remaining.map((item) => item.emailDomain)).toEqual(["two.test"]);
  });

  it("skips a domain that would exceed share percent when another domain exists", () => {
    const filtered = applyDomainDiversityFilter(
      [
        candidate("a", {
          domain: "one.test",
          membership: membership("a", { currentDailyWarmupVolume: 7 }),
        }),
        candidate("b", {
          domain: "two.test",
          membership: membership("b", { currentDailyWarmupVolume: 0 }),
        }),
      ],
      pool({ maxDomainSharePercent: 50 }),
      now,
    );
    expect(filtered.remaining.map((item) => item.emailDomain)).toEqual(["two.test"]);
  });

  it("ROUND_ROBIN prefers the mailbox that was selected longest ago", () => {
    const older = candidate("a", { membership: membership("a", { lastSelectedAt: new Date("2026-08-19T10:00:00.000Z") }) });
    const newer = candidate("b", { membership: membership("b", { lastSelectedAt: new Date("2026-08-19T11:00:00.000Z") }) });
    expect(compareByStrategy(older, newer, "ROUND_ROBIN", now)).toBeLessThan(0);
  });

  it("LEAST_USED prefers lower daily usage", () => {
    const heavy = candidate("a", { membership: membership("a", { currentDailyWarmupVolume: 5 }) });
    const light = candidate("b", { membership: membership("b", { currentDailyWarmupVolume: 1 }) });
    expect(compareByStrategy(light, heavy, "LEAST_USED", now)).toBeLessThan(0);
  });

  it("WEIGHTED prefers higher weight deterministically", () => {
    const low = candidate("a", { membership: membership("a", { weight: 1 }) });
    const high = candidate("b", { membership: membership("b", { weight: 10 }) });
    expect(compareByStrategy(high, low, "WEIGHTED", now)).toBeLessThan(0);
  });

  it("HEALTH_FIRST prefers HEALTHY over DEGRADED", () => {
    const healthy = candidate("a");
    const degraded = candidate("b", { sendingHealth: "DEGRADED" });
    expect(compareByStrategy(healthy, degraded, "HEALTH_FIRST", now)).toBeLessThan(0);
  });

  it("selects stably by mailbox id when scores tie", () => {
    const first = selectEligibleMailbox([candidate("bbb"), candidate("aaa")], pool({ strategy: "LEAST_USED" }), now);
    const second = selectEligibleMailbox([candidate("aaa"), candidate("bbb")], pool({ strategy: "LEAST_USED" }), now);
    expect(first.selected?.membership.mailboxId).toBe(asMailboxId("aaa"));
    expect(second.selected?.membership.mailboxId).toBe(first.selected?.membership.mailboxId);
  });

  it("returns no eligible mailbox when every candidate is skipped", () => {
    const result = selectEligibleMailbox(
      [candidate("a", { mailboxStatus: "DISCONNECTED" }), candidate("b", { credentialAvailable: false })],
      pool(),
      now,
    );
    expect(result.selected).toBeUndefined();
    expect(result.skipped.length).toBe(2);
  });

  it("HEALTH_FIRST_LEAST_USED composes health then usage", () => {
    const result = selectEligibleMailbox(
      [
        candidate("a", { sendingHealth: "DEGRADED", membership: membership("a", { currentDailyWarmupVolume: 0 }) }),
        candidate("b", { membership: membership("b", { currentDailyWarmupVolume: 2 }) }),
      ],
      pool({ strategy: "HEALTH_FIRST_LEAST_USED" }),
      now,
    );
    expect(result.selected?.membership.mailboxId).toBe(asMailboxId("b"));
  });
});

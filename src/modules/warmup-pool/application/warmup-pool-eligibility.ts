import type { MailboxStatus } from "../../mailbox/domain/mailbox.js";
import type { HealthStatus } from "../../health/domain/mailbox-health.js";
import type { ReputationStatus } from "../../reputation/domain/reputation-assessment.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";
import { deriveDomainHealth } from "../domain/derived-domain-health.js";
import type { WarmupPool, WarmupPoolStrategy } from "../domain/warmup-pool.js";
import {
  effectiveDailyUsage,
  type WarmupPoolMembership,
  type WarmupPoolMembershipStatus,
} from "../domain/warmup-pool-membership.js";

export const WARMUP_POOL_SKIP_REASONS = [
  "POOL_NOT_ACTIVE",
  "MEMBERSHIP_DISABLED",
  "MAILBOX_DISCONNECTED",
  "MAILBOX_DISABLED",
  "CREDENTIAL_UNAVAILABLE",
  "PROVIDER_UNHEALTHY",
  "MAILBOX_UNHEALTHY",
  "REPUTATION_BLOCKED",
  "RISK_BLOCKED",
  "DAILY_CAPACITY_EXHAUSTED",
  "IN_COOLDOWN",
  "DOMAIN_CONCENTRATION",
  "DOMAIN_HEALTH_UNKNOWN",
  "DOMAIN_HEALTH_BLOCKED",
] as const;
export type WarmupPoolSkipReason = (typeof WARMUP_POOL_SKIP_REASONS)[number];

export interface WarmupPoolCandidate {
  readonly membership: WarmupPoolMembership;
  readonly mailboxStatus: MailboxStatus;
  readonly mailboxEnabled: boolean;
  readonly emailDomain: string;
  readonly credentialAvailable: boolean;
  readonly providerAccountStatus?: string;
  readonly connectionHealth?: HealthStatus;
  readonly authenticationHealth?: HealthStatus;
  readonly sendingHealth?: HealthStatus;
  readonly domainHealth?: HealthStatus;
  readonly riskLevel?: RiskLevel;
  readonly reputationStatus?: ReputationStatus;
}

export interface EligibilityEvaluation {
  readonly eligible: boolean;
  readonly reasons: readonly WarmupPoolSkipReason[];
}

function inCooldown(cooldownUntil: Date | undefined, now: Date): boolean {
  return cooldownUntil !== undefined && cooldownUntil.getTime() > now.getTime();
}

const SELECTABLE_MEMBERSHIP: ReadonlySet<WarmupPoolMembershipStatus> = new Set(["AVAILABLE", "ACTIVE"]);

export function evaluatePoolMembershipEligibility(pool: WarmupPool, candidate: WarmupPoolCandidate, now: Date): EligibilityEvaluation {
  const reasons: WarmupPoolSkipReason[] = [];
  if (pool.status !== "ACTIVE") {
    reasons.push("POOL_NOT_ACTIVE");
  }
  if (!SELECTABLE_MEMBERSHIP.has(candidate.membership.status)) {
    reasons.push("MEMBERSHIP_DISABLED");
  }
  if (candidate.mailboxStatus !== "CONNECTED") {
    reasons.push("MAILBOX_DISCONNECTED");
  }
  if (!candidate.mailboxEnabled) {
    reasons.push("MAILBOX_DISABLED");
  }
  if (!candidate.credentialAvailable) {
    reasons.push("CREDENTIAL_UNAVAILABLE");
  }
  if (candidate.providerAccountStatus !== undefined && candidate.providerAccountStatus !== "ACTIVE") {
    reasons.push("PROVIDER_UNHEALTHY");
  }
  if (candidate.connectionHealth === "UNHEALTHY" || candidate.authenticationHealth === "UNHEALTHY") {
    reasons.push("PROVIDER_UNHEALTHY");
  }
  if (candidate.sendingHealth === "UNHEALTHY") {
    reasons.push("MAILBOX_UNHEALTHY");
  }
  if (candidate.reputationStatus === "POOR" || candidate.reputationStatus === "CRITICAL") {
    reasons.push("REPUTATION_BLOCKED");
  }
  if (candidate.riskLevel === "HIGH" || candidate.riskLevel === "CRITICAL") {
    reasons.push("RISK_BLOCKED");
  }
  const usage = effectiveDailyUsage(candidate.membership, now);
  if (candidate.membership.maxDailyWarmupVolume !== undefined && usage >= candidate.membership.maxDailyWarmupVolume) {
    reasons.push("DAILY_CAPACITY_EXHAUSTED");
  }
  if (inCooldown(candidate.membership.cooldownUntil, now) || candidate.membership.status === "COOLDOWN") {
    if (!reasons.includes("IN_COOLDOWN")) {
      reasons.push("IN_COOLDOWN");
    }
  }
  const domainHealth = deriveDomainHealth({
    sendingHealth: candidate.sendingHealth,
    connectionHealth: candidate.connectionHealth,
    authenticationHealth: candidate.authenticationHealth,
    domainHealth: candidate.domainHealth,
    riskLevel: candidate.riskLevel,
    reputationStatus: candidate.reputationStatus,
  });
  if (domainHealth === "UNKNOWN") {
    reasons.push("DOMAIN_HEALTH_UNKNOWN");
  } else if (domainHealth === "BLOCKED") {
    reasons.push("DOMAIN_HEALTH_BLOCKED");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function applyDomainDiversityFilter(
  eligible: readonly WarmupPoolCandidate[],
  pool: WarmupPool,
  now: Date,
): { readonly remaining: WarmupPoolCandidate[]; readonly skipped: WarmupPoolCandidate[] } {
  if (eligible.length === 0) {
    return { remaining: [], skipped: [] };
  }
  const uniqueDomains = new Set(eligible.map((candidate) => candidate.emailDomain));
  if (uniqueDomains.size === 1) {
    return { remaining: [...eligible], skipped: [] };
  }

  const today = now.toISOString().slice(0, 10);
  const usageByDomain = new Map<string, number>();
  for (const candidate of eligible) {
    const used = candidate.membership.usageDate === today ? candidate.membership.currentDailyWarmupVolume : 0;
    usageByDomain.set(candidate.emailDomain, (usageByDomain.get(candidate.emailDomain) ?? 0) + used);
  }
  const totalUsageToday = [...usageByDomain.values()].reduce((sum, value) => sum + value, 0);

  const skipped: WarmupPoolCandidate[] = [];
  const remaining: WarmupPoolCandidate[] = [];
  for (const candidate of eligible) {
    const consecutiveBlocked =
      pool.lastSelectedDomain === candidate.emailDomain && pool.consecutiveSameDomain >= pool.maxConsecutiveSameDomain;
    const domainUsage = usageByDomain.get(candidate.emailDomain) ?? 0;
    const projectedShare = totalUsageToday === 0 ? 0 : Math.floor(((domainUsage + 1) * 100) / (totalUsageToday + 1));
    const shareBlocked = totalUsageToday > 0 && projectedShare > pool.maxDomainSharePercent;
    if (consecutiveBlocked || shareBlocked) {
      skipped.push(candidate);
    } else {
      remaining.push(candidate);
    }
  }
  if (remaining.length === 0) {
    return { remaining: [...eligible], skipped: [] };
  }
  return { remaining, skipped };
}

export function healthRank(candidate: WarmupPoolCandidate): number {
  const domainHealth = deriveDomainHealth({
    sendingHealth: candidate.sendingHealth,
    connectionHealth: candidate.connectionHealth,
    authenticationHealth: candidate.authenticationHealth,
    domainHealth: candidate.domainHealth,
    riskLevel: candidate.riskLevel,
    reputationStatus: candidate.reputationStatus,
  });
  if (domainHealth === "HEALTHY") {
    return 3;
  }
  if (domainHealth === "DEGRADED") {
    return 1;
  }
  return 0;
}

export function compareByStrategy(
  a: WarmupPoolCandidate,
  b: WarmupPoolCandidate,
  strategy: WarmupPoolStrategy,
  now: Date,
): number {
  const usageA = effectiveDailyUsage(a.membership, now);
  const usageB = effectiveDailyUsage(b.membership, now);
  const lastA = a.membership.lastSelectedAt?.getTime() ?? 0;
  const lastB = b.membership.lastSelectedAt?.getTime() ?? 0;
  const idCmp = a.membership.mailboxId < b.membership.mailboxId ? -1 : a.membership.mailboxId > b.membership.mailboxId ? 1 : 0;

  if (strategy === "ROUND_ROBIN") {
    if (lastA !== lastB) {
      return lastA - lastB;
    }
    if (a.membership.priority !== b.membership.priority) {
      return b.membership.priority - a.membership.priority;
    }
    return idCmp;
  }

  if (strategy === "LEAST_USED") {
    if (usageA !== usageB) {
      return usageA - usageB;
    }
    if (lastA !== lastB) {
      return lastA - lastB;
    }
    return idCmp;
  }

  if (strategy === "WEIGHTED") {
    const scoreA = a.membership.weight * 1_000_000 + a.membership.priority * 1_000 - usageA;
    const scoreB = b.membership.weight * 1_000_000 + b.membership.priority * 1_000 - usageB;
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return idCmp;
  }

  if (strategy === "HEALTH_FIRST") {
    const healthA = healthRank(a);
    const healthB = healthRank(b);
    if (healthA !== healthB) {
      return healthB - healthA;
    }
    if (a.membership.priority !== b.membership.priority) {
      return b.membership.priority - a.membership.priority;
    }
    return idCmp;
  }

  const healthA = healthRank(a);
  const healthB = healthRank(b);
  if (healthA !== healthB) {
    return healthB - healthA;
  }
  if (usageA !== usageB) {
    return usageA - usageB;
  }
  if (a.membership.priority !== b.membership.priority) {
    return b.membership.priority - a.membership.priority;
  }
  if (lastA !== lastB) {
    return lastA - lastB;
  }
  return idCmp;
}

export function selectEligibleMailbox(
  candidates: readonly WarmupPoolCandidate[],
  pool: WarmupPool,
  now: Date,
): { readonly selected?: WarmupPoolCandidate; readonly skipped: ReadonlyArray<{ candidate: WarmupPoolCandidate; reasons: readonly WarmupPoolSkipReason[] }> } {
  const skipped: Array<{ candidate: WarmupPoolCandidate; reasons: readonly WarmupPoolSkipReason[] }> = [];
  const eligible: WarmupPoolCandidate[] = [];
  for (const candidate of candidates) {
    const evaluation = evaluatePoolMembershipEligibility(pool, candidate, now);
    if (evaluation.eligible) {
      eligible.push(candidate);
    } else {
      skipped.push({ candidate, reasons: evaluation.reasons });
    }
  }
  const diversified = applyDomainDiversityFilter(eligible, pool, now);
  for (const candidate of diversified.skipped) {
    skipped.push({ candidate, reasons: ["DOMAIN_CONCENTRATION"] });
  }
  const ranked = [...diversified.remaining].sort((a, b) => compareByStrategy(a, b, pool.strategy, now));
  return { ...(ranked[0] ? { selected: ranked[0] } : {}), skipped };
}

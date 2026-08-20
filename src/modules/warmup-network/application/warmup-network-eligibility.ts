import type { MailboxStatus } from "../../mailbox/domain/mailbox.js";
import type { WarmupNetworkDomain } from "../domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import {
  remainingCapacity,
  type WarmupNetworkProvider,
} from "../domain/warmup-network-status.js";

export interface WarmupNetworkEligibilityConfig {
  readonly minHealthScore: number;
  readonly requireSpf: boolean;
  readonly requireDkim: boolean;
  readonly requireDmarc: boolean;
}

export const WARMUP_INELIGIBILITY_REASONS = [
  "STATUS_NOT_ACTIVE",
  "IN_COOLDOWN",
  "PROVIDER_UNSUPPORTED",
  "SPF_NOT_PASS",
  "DKIM_NOT_PASS",
  "DMARC_NOT_PASS",
  "HEALTH_BELOW_THRESHOLD",
  "CAPACITY_EXHAUSTED",
  "REPUTATION_POOR_OR_CRITICAL",
  "CREDENTIAL_UNAVAILABLE",
  "LINKED_MAILBOX_NOT_READY",
  "PARENT_DOMAIN_INELIGIBLE",
] as const;
export type WarmupIneligibilityReason = (typeof WARMUP_INELIGIBILITY_REASONS)[number];

export const TEMPORARY_INELIGIBILITY_REASONS: ReadonlySet<WarmupIneligibilityReason> = new Set([
  "IN_COOLDOWN",
  "CAPACITY_EXHAUSTED",
]);

export interface EligibilityEvaluation {
  readonly eligible: boolean;
  readonly reasons: readonly WarmupIneligibilityReason[];
}

const SUPPORTED_PROVIDERS = new Set<WarmupNetworkProvider>(["GMAIL", "MICROSOFT365"]);

function inCooldown(cooldownUntil: Date | undefined, now: Date): boolean {
  return cooldownUntil !== undefined && cooldownUntil.getTime() > now.getTime();
}

function pushAvailabilityReasons(
  reasons: WarmupIneligibilityReason[],
  status: WarmupNetworkDomain["status"] | WarmupNetworkMailbox["status"],
  cooldownUntil: Date | undefined,
  now: Date,
): void {
  if (status === "COOLDOWN" || inCooldown(cooldownUntil, now)) {
    reasons.push("IN_COOLDOWN");
  } else if (status !== "ACTIVE") {
    reasons.push("STATUS_NOT_ACTIVE");
  }
}

export function evaluateWarmupDomainEligibility(
  domain: WarmupNetworkDomain,
  now: Date,
  config: WarmupNetworkEligibilityConfig,
): EligibilityEvaluation {
  const reasons: WarmupIneligibilityReason[] = [];
  pushAvailabilityReasons(reasons, domain.status, domain.cooldownUntil, now);
  if (!SUPPORTED_PROVIDERS.has(domain.provider)) {
    reasons.push("PROVIDER_UNSUPPORTED");
  }
  if (config.requireSpf && domain.spfStatus !== "PASS") {
    reasons.push("SPF_NOT_PASS");
  }
  if (config.requireDkim && domain.dkimStatus !== "PASS") {
    reasons.push("DKIM_NOT_PASS");
  }
  if (config.requireDmarc && domain.dmarcStatus !== "PASS") {
    reasons.push("DMARC_NOT_PASS");
  }
  if (domain.healthScore < config.minHealthScore) {
    reasons.push("HEALTH_BELOW_THRESHOLD");
  }
  const remaining = remainingCapacity(domain.dailyCapacity, domain.usageDate, domain.usageCount, now);
  if (remaining <= 0 || (domain.capacityStatus === "EXHAUSTED" && remaining <= 0)) {
    reasons.push("CAPACITY_EXHAUSTED");
  }
  if (domain.reputationStatus === "POOR" || domain.reputationStatus === "CRITICAL") {
    reasons.push("REPUTATION_POOR_OR_CRITICAL");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function isWarmupDomainEligible(
  domain: WarmupNetworkDomain,
  now: Date,
  config: WarmupNetworkEligibilityConfig,
): boolean {
  return evaluateWarmupDomainEligibility(domain, now, config).eligible;
}

export interface LinkedMailboxReadiness {
  readonly status: MailboxStatus;
  readonly enabled: boolean;
}

export function evaluateWarmupMailboxEligibility(
  mailbox: WarmupNetworkMailbox,
  parentDomain: WarmupNetworkDomain,
  now: Date,
  config: WarmupNetworkEligibilityConfig,
  linkedMailbox?: LinkedMailboxReadiness,
): EligibilityEvaluation {
  const reasons: WarmupIneligibilityReason[] = [];
  const parent = evaluateWarmupDomainEligibility(parentDomain, now, config);
  if (!parent.eligible) {
    reasons.push("PARENT_DOMAIN_INELIGIBLE");
    for (const reason of parent.reasons) {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }
  pushAvailabilityReasons(reasons, mailbox.status, mailbox.cooldownUntil, now);
  if (!SUPPORTED_PROVIDERS.has(mailbox.provider)) {
    reasons.push("PROVIDER_UNSUPPORTED");
  }
  if (!mailbox.credentialAvailable) {
    reasons.push("CREDENTIAL_UNAVAILABLE");
  }
  if (linkedMailbox && (linkedMailbox.status !== "CONNECTED" || !linkedMailbox.enabled)) {
    reasons.push("LINKED_MAILBOX_NOT_READY");
  }
  if (mailbox.healthScore < config.minHealthScore) {
    reasons.push("HEALTH_BELOW_THRESHOLD");
  }
  const remaining = remainingCapacity(mailbox.dailyCapacity, mailbox.usageDate, mailbox.usageCount, now);
  if (remaining <= 0) {
    reasons.push("CAPACITY_EXHAUSTED");
  }
  if (mailbox.reputationState === "POOR" || mailbox.reputationState === "CRITICAL") {
    reasons.push("REPUTATION_POOR_OR_CRITICAL");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function isWarmupMailboxEligible(
  mailbox: WarmupNetworkMailbox,
  parentDomain: WarmupNetworkDomain,
  now: Date,
  config: WarmupNetworkEligibilityConfig,
  linkedMailbox?: LinkedMailboxReadiness,
): boolean {
  return evaluateWarmupMailboxEligibility(mailbox, parentDomain, now, config, linkedMailbox).eligible;
}

function reasonsForFailureClass(reasons: readonly WarmupIneligibilityReason[]): readonly WarmupIneligibilityReason[] {
  const withoutParentMarker = reasons.filter((reason) => reason !== "PARENT_DOMAIN_INELIGIBLE");
  return withoutParentMarker.length > 0 ? withoutParentMarker : reasons;
}

export function classifyEmptyPoolFailure(
  evaluations: readonly EligibilityEvaluation[],
): { reason: string; failureClass: "TEMPORARY" | "PERMANENT" } {
  if (evaluations.length === 0) {
    return { reason: "EMPTY_POOL", failureClass: "PERMANENT" };
  }
  const wouldBeEligibleAfterWait = evaluations.some((evaluation) => {
    const reasons = reasonsForFailureClass(evaluation.reasons);
    return reasons.length > 0 && reasons.every((reason) => TEMPORARY_INELIGIBILITY_REASONS.has(reason));
  });
  if (wouldBeEligibleAfterWait) {
    const cooldownOnly = evaluations.some((evaluation) => {
      const reasons = reasonsForFailureClass(evaluation.reasons);
      return reasons.length > 0 && reasons.every((reason) => reason === "IN_COOLDOWN");
    });
    return {
      reason: cooldownOnly ? "COOLDOWN" : "CAPACITY_EXHAUSTED",
      failureClass: "TEMPORARY",
    };
  }
  return { reason: "NO_ELIGIBLE_WARMUP_MAILBOX", failureClass: "PERMANENT" };
}

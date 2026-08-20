import type { HealthStatus } from "../../health/domain/mailbox-health.js";
import type { ReputationStatus } from "../../reputation/domain/reputation-assessment.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";

export const DERIVED_DOMAIN_HEALTH_STATUSES = ["HEALTHY", "DEGRADED", "BLOCKED", "UNKNOWN"] as const;
export type DerivedDomainHealth = (typeof DERIVED_DOMAIN_HEALTH_STATUSES)[number];

export interface DerivedDomainHealthInput {
  readonly sendingHealth?: HealthStatus | undefined;
  readonly connectionHealth?: HealthStatus | undefined;
  readonly authenticationHealth?: HealthStatus | undefined;
  readonly domainHealth?: HealthStatus | undefined;
  readonly riskLevel?: RiskLevel | undefined;
  readonly reputationStatus?: ReputationStatus | undefined;
}

/**
 * Tiny derived view for pool selection only. Reuses existing mailbox
 * health/risk/reputation — not a second reputation engine. UNKNOWN is
 * conservative (selector must not treat "not measured" as healthy).
 */
export function deriveDomainHealth(input: DerivedDomainHealthInput): DerivedDomainHealth {
  if (
    input.sendingHealth === undefined ||
    input.connectionHealth === undefined ||
    input.authenticationHealth === undefined ||
    input.riskLevel === undefined
  ) {
    return "UNKNOWN";
  }
  if (
    input.sendingHealth === "UNKNOWN" ||
    input.connectionHealth === "UNKNOWN" ||
    input.authenticationHealth === "UNKNOWN" ||
    input.riskLevel === "UNKNOWN" ||
    input.reputationStatus === "UNKNOWN" ||
    input.reputationStatus === undefined
  ) {
    return "UNKNOWN";
  }
  if (
    input.sendingHealth === "UNHEALTHY" ||
    input.connectionHealth === "UNHEALTHY" ||
    input.authenticationHealth === "UNHEALTHY" ||
    input.riskLevel === "CRITICAL" ||
    input.reputationStatus === "POOR" ||
    input.reputationStatus === "CRITICAL"
  ) {
    return "BLOCKED";
  }
  if (
    input.sendingHealth === "DEGRADED" ||
    input.connectionHealth === "DEGRADED" ||
    input.authenticationHealth === "DEGRADED" ||
    input.domainHealth === "DEGRADED" ||
    input.riskLevel === "HIGH" ||
    input.reputationStatus === "DEGRADED"
  ) {
    return "DEGRADED";
  }
  return "HEALTHY";
}

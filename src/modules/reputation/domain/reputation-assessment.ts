import type { MailboxId, ReputationAssessmentId, TenantId } from "../../../shared/types/index.js";

export const REPUTATION_STATUSES = ["EXCELLENT", "HEALTHY", "DEGRADED", "POOR", "CRITICAL", "UNKNOWN"] as const;
export type ReputationStatus = (typeof REPUTATION_STATUSES)[number];

export const TREND_DIRECTIONS = ["IMPROVING", "STABLE", "DEGRADING", "UNKNOWN"] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

/**
 * Deliberately a fresh, local severity type rather than importing `risk`'s
 * `RiskLevel` — same reasoning `warmup`'s `ProviderSendResult` deliberately
 * duplicates `providers`' `ProviderSendOutcome` vocabulary rather than
 * importing it backward (see `warmup/domain/send-result.ts`): the
 * dependency direction is `reputation → risk` (risk consumes reputation
 * factors, never the reverse), so reputation cannot import risk's types
 * without inverting it.
 */
export const REPUTATION_FACTOR_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ReputationFactorSeverity = (typeof REPUTATION_FACTOR_SEVERITIES)[number];

/** `code` is a stable, machine-readable identifier `risk` maps to its own risk factors; `description` is safe/human-readable — never a raw provider payload. */
export interface ReputationFactor {
  readonly code: string;
  readonly description: string;
  readonly severity: ReputationFactorSeverity;
}

export interface ReputationTrends {
  readonly delivery: TrendDirection;
  readonly bounce: TrendDirection;
  readonly throttle: TrendDirection;
  readonly failure: TrendDirection;
  readonly complaint: TrendDirection;
}

/**
 * A rate is `"UNKNOWN"`, never a fabricated `0`, whenever the window's
 * event count is below `MIN_SAMPLE_SIZE_FOR_RATE` (Stage 10 spec section
 * 6/23: "No complaint data available ≠ 0 complaints"). Every rate is
 * `count / eventCount`, 0-1, computed only once there is enough evidence
 * to mean something.
 */
export type Rate = number | "UNKNOWN";

export interface ReputationWindowEvidence {
  readonly eventCount: number;
  readonly deliveryRate: Rate;
  readonly bounceRate: Rate;
  readonly hardBounceRate: Rate;
  readonly softBounceRate: Rate;
  readonly throttleRate: Rate;
  readonly rejectionRate: Rate;
  readonly failureRate: Rate;
  readonly complaintRate: Rate;
  readonly unknownRate: Rate;
}

/**
 * The deterministic, persisted output of `application/reputation-policy.ts`
 * (Stage 10 spec section 9) — mailbox-level, evidence-derived, and
 * explicitly NOT a replacement for `risk`'s own `RiskAssessment`: this
 * feeds `risk` as an additional input (`application/risk-policy.ts`'s
 * `RiskPolicyInput.reputation`), it never decides risk or warmup volume
 * itself (Stage 10 spec section 9/16 — "the risk engine remains
 * authoritative"). Append-only history via
 * `infrastructure/postgres-reputation-repository.ts` — see
 * migrations/019_create_reputation_assessments.sql.
 */
export interface ReputationAssessment {
  readonly id: ReputationAssessmentId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly status: ReputationStatus;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly factors: readonly ReputationFactor[];
  readonly trends: ReputationTrends;
  readonly last24h: ReputationWindowEvidence;
  readonly last7d: ReputationWindowEvidence;
  readonly lifetime: ReputationWindowEvidence;
  readonly assessedAt: Date;
  readonly createdAt: Date;
}

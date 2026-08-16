export const ELIGIBILITY_DECISIONS = ["ELIGIBLE", "CONDITIONALLY_ELIGIBLE", "NOT_ELIGIBLE", "REQUIRES_REVIEW"] as const;
export type EligibilityDecision = (typeof ELIGIBILITY_DECISIONS)[number];

/**
 * The single authoritative output of `WarmupEligibilityPolicy`
 * (application/warmup-eligibility-policy.ts) — Stage 7 spec section 11:
 * "There must be one authoritative policy boundary." A future warmup
 * scheduler consumes `decision` directly; it must never infer eligibility
 * by re-deriving it from raw health/risk fields itself. `reasons` always
 * explains the decision — confirmations and concerns alike (Stage 7 spec
 * section 19) — and must never leak internal state that could reveal a
 * secret (it never does, since every input here is already a safe,
 * normalized `HealthStatus`/`RiskLevel`, not a raw error).
 */
export interface WarmupEligibilityAssessment {
  readonly decision: EligibilityDecision;
  readonly reasons: readonly string[];
  readonly assessedAt: Date;
}

export const RISK_LEVELS = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** `code` is a stable, machine-readable identifier; `description` is the safe, human-readable explanation — never a raw provider/DNS error. */
export interface RiskFactor {
  readonly code: string;
  readonly description: string;
  readonly severity: RiskLevel;
}

/**
 * `riskScore` is a representation of `riskFactors`, never the other way
 * around (Stage 7 spec section 10: "the score is a representation, not the
 * decision engine") — `application/risk-policy.ts` derives the score by
 * summing each triggered factor's configured weight, capped at 100, and
 * `riskLevel` by threshold on that score. An integer 0-100, not
 * "72.3819" — the spec's own example of the precision to avoid.
 */
export interface RiskAssessment {
  readonly riskLevel: RiskLevel;
  readonly riskScore: number;
  readonly riskFactors: readonly RiskFactor[];
  readonly assessedAt: Date;
}

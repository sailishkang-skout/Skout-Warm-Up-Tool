import type { ConfidenceLevel } from "../../health/domain/signal.js";

/**
 * A range plus a point recommendation, not a single "send 50/day" number
 * (Stage 7 spec section 13) — `minimumDailyVolume`/`maximumDailyVolume`
 * bound how confidently that single number should be trusted.
 * `application/capacity-policy.ts` derives this from eligibility + risk +
 * health only; it never fabricates historical sending behavior this
 * mailbox doesn't have yet (no warmup engine has ever sent from it).
 */
export interface CapacityRecommendation {
  readonly recommendedDailyVolume: number;
  readonly minimumDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly confidence: ConfidenceLevel;
  readonly reasons: readonly string[];
  readonly assessedAt: Date;
}

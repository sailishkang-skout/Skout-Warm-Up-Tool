import type { CapacityRecommendation } from "../domain/capacity-recommendation.js";
import type { EligibilityDecision } from "../domain/warmup-eligibility.js";

/**
 * Deliberately conservative, fixed starter-ramp numbers, not derived from
 * any per-mailbox history — no warmup engine has ever sent from any
 * mailbox yet, so there is no real historical behavior to base a
 * recommendation on (Stage 7 spec section 13: "Do not invent historical
 * behavior. ... use only signals actually available"). These exist so the
 * capacity endpoint returns something meaningful today; a later stage with
 * actual delivery-event history should replace these constants with a
 * model that uses it, not the other way around.
 */
const CAPACITY_BANDS = {
  ELIGIBLE: { minimum: 5, recommended: 10, maximum: 20, confidence: "HIGH" } as const,
  CONDITIONALLY_ELIGIBLE: { minimum: 3, recommended: 5, maximum: 10, confidence: "MEDIUM" } as const,
  NOT_ELIGIBLE: { minimum: 0, recommended: 0, maximum: 0, confidence: "LOW" } as const,
  REQUIRES_REVIEW: { minimum: 0, recommended: 0, maximum: 0, confidence: "LOW" } as const,
} satisfies Record<EligibilityDecision, { minimum: number; recommended: number; maximum: number; confidence: "HIGH" | "MEDIUM" | "LOW" }>;

const REASONS: Record<EligibilityDecision, readonly string[]> = {
  ELIGIBLE: ["Mailbox is eligible for warmup — starting-ramp capacity recommended."],
  CONDITIONALLY_ELIGIBLE: ["Mailbox is conditionally eligible — a reduced starting capacity is recommended until outstanding concerns are resolved."],
  NOT_ELIGIBLE: ["Mailbox is not eligible for warmup; no capacity is recommended."],
  REQUIRES_REVIEW: ["Eligibility requires review before a capacity recommendation can be made."],
};

/**
 * Pure and deterministic (Stage 7 spec section 23) — the eligibility
 * decision alone determines the band; nothing here reads a clock, a
 * database, or a provider.
 */
export function recommendCapacity(eligibility: EligibilityDecision, assessedAt: Date): CapacityRecommendation {
  const band = CAPACITY_BANDS[eligibility];
  return {
    recommendedDailyVolume: band.recommended,
    minimumDailyVolume: band.minimum,
    maximumDailyVolume: band.maximum,
    confidence: band.confidence,
    reasons: REASONS[eligibility],
    assessedAt,
  };
}

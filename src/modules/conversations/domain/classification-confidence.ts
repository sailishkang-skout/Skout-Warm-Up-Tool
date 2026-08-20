/**
 * Confidence is a classifier score in [0, 1], not a calibrated probability.
 * Documented bands (guidance only):
 *   0.95–1.00 deterministic / high certainty
 *   0.80–0.94 strong AI classification
 *   0.60–0.79 moderate
 *   <0.60     weak / treat as UNKNOWN unless the label is already UNKNOWN/NEUTRAL
 *
 * Persisted HIGH/MEDIUM/LOW use the thresholds below (Stage 13B), which are
 * slightly wider than the documented score bands so historical rows stay stable.
 */
export const CONFIDENCE_BANDS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const HIGH_CONFIDENCE_MIN = 0.85;
export const MEDIUM_CONFIDENCE_MIN = 0.65;
export const WEAK_CONFIDENCE_MAX = 0.6;

export function confidenceBandOf(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_CONFIDENCE_MIN) {
    return "HIGH";
  }
  if (confidence >= MEDIUM_CONFIDENCE_MIN) {
    return "MEDIUM";
  }
  return "LOW";
}

import type { ConfidenceLevel } from "../../health/domain/signal.js";

/**
 * The ramp policy's output for one warmup day (Stage 8 spec section 6) — a
 * bounded range plus a point recommendation, mirroring `policy`'s own
 * `CapacityRecommendation` shape deliberately: this is the same kind of
 * fact (an explainable volume recommendation), just re-evaluated daily
 * against ramp progression rather than computed once per assessment.
 */
export interface DailyWarmupTarget {
  readonly minimum: number;
  readonly recommended: number;
  readonly maximum: number;
  readonly confidence: ConfidenceLevel;
  readonly reasons: readonly string[];
}

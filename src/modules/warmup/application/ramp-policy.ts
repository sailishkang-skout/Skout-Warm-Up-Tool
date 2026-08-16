import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { CapacityRecommendation } from "../../policy/domain/capacity-recommendation.js";
import type { WarmupEligibilityAssessment } from "../../policy/domain/warmup-eligibility.js";
import type { RiskAssessment, RiskLevel } from "../../risk/domain/risk-assessment.js";
import type { ConfidenceLevel } from "../../health/domain/signal.js";
import type { DailyWarmupTarget } from "../domain/daily-warmup-target.js";
import type { RampStrategy, RiskTolerance } from "../domain/warmup-profile.js";

export interface RampPolicyProfileInput {
  readonly startingDailyVolume: number;
  readonly targetDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly rampStrategy: RampStrategy;
  readonly riskTolerance: RiskTolerance;
  readonly active: boolean;
}

export interface CalculateWarmupTargetInput {
  readonly currentDay: number;
  /** The previous day's `recommended` target, or `undefined` on day 1 / after a gap with no prior decision. */
  readonly previousTarget: number | undefined;
  readonly capacity: CapacityRecommendation;
  readonly risk: RiskAssessment;
  readonly eligibility: WarmupEligibilityAssessment;
  readonly health: MailboxHealthAssessment;
  readonly profile: RampPolicyProfileInput;
}

/** Volume added per day under pure day-based progression, before any risk adjustment — deliberately small, round numbers per ramp strategy, never provider-specific. */
const DAILY_STEP_BY_STRATEGY: Readonly<Record<RampStrategy, number>> = {
  CONSERVATIVE: 1,
  STANDARD: 2,
  AGGRESSIVE: 5,
};

function downgradeConfidence(confidence: ConfidenceLevel): ConfidenceLevel {
  return confidence === "HIGH" ? "MEDIUM" : "LOW";
}

function zeroTarget(reasons: readonly string[]): DailyWarmupTarget {
  return { minimum: 0, recommended: 0, maximum: 0, confidence: "LOW", reasons };
}

const RISK_ORDER: readonly RiskLevel[] = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

/**
 * `riskTolerance` (Stage 7's `WarmupProfile`) shifts LOW/MEDIUM/HIGH by one
 * step in either direction — deliberately never touches `CRITICAL` or
 * `UNKNOWN`: no profile setting is allowed to talk the engine out of
 * pausing on a genuinely critical signal, or into treating an unmeasured
 * state as known-safe.
 */
function effectiveRiskLevel(riskLevel: RiskLevel, tolerance: RiskTolerance): RiskLevel {
  if (riskLevel === "CRITICAL" || riskLevel === "UNKNOWN") {
    return riskLevel;
  }
  const shift = tolerance === "HIGH" ? -1 : tolerance === "LOW" ? 1 : 0;
  const index = RISK_ORDER.indexOf(riskLevel);
  const shifted = RISK_ORDER[Math.min(Math.max(index + shift, 1), 3)];
  return shifted ?? riskLevel;
}

/**
 * Pure and deterministic (Stage 8 spec section 23) — no clock reads, no
 * I/O. Bounded on every path by `profile.maximumDailyVolume` and
 * `capacity.maximumDailyVolume` (Stage 8 spec section 6: never a runaway
 * increase); never branches on a specific provider type or hardcodes a
 * provider-specific volume (section 32) — provider capacity already flows
 * in normalized through `capacity` (policy module, Stage 7).
 *
 * Priority order, matching Stage 8 spec section 7's examples exactly:
 *   1. `profile.active === false`           → zero (a paused/draft profile never ramps).
 *   2. eligibility NOT_ELIGIBLE/REQUIRES_REVIEW → zero.
 *   3. risk CRITICAL                        → zero ("pause").
 *   4. risk HIGH                            → reduce from `previousTarget` (never grow).
 *   5. risk MEDIUM                          → half-speed progression ("conservative").
 *   6. risk LOW (and CONDITIONALLY_ELIGIBLE/ELIGIBLE) → normal day-based progression.
 */
export function calculateWarmupTarget(input: CalculateWarmupTargetInput): DailyWarmupTarget {
  const { currentDay, previousTarget, capacity, risk, eligibility, health, profile } = input;

  if (!profile.active) {
    return zeroTarget(["Warmup profile is not active."]);
  }

  if (eligibility.decision === "NOT_ELIGIBLE") {
    return zeroTarget(["Mailbox is not eligible for warmup.", ...eligibility.reasons]);
  }
  if (eligibility.decision === "REQUIRES_REVIEW") {
    return zeroTarget(["Eligibility requires review before any volume can be recommended.", ...eligibility.reasons]);
  }

  if (risk.riskLevel === "CRITICAL") {
    return zeroTarget(["Risk level is CRITICAL — warmup volume paused until risk subsides."]);
  }

  const hardCeiling = Math.min(profile.maximumDailyVolume, capacity.maximumDailyVolume);
  const step = DAILY_STEP_BY_STRATEGY[profile.rampStrategy];
  const dayProgression = Math.min(
    profile.startingDailyVolume + (currentDay - 1) * step,
    profile.targetDailyVolume,
  );

  const reasons: string[] = [];
  let recommended: number;
  const effectiveRisk = effectiveRiskLevel(risk.riskLevel, profile.riskTolerance);
  if (effectiveRisk !== risk.riskLevel) {
    reasons.push(`Profile risk tolerance (${profile.riskTolerance}) adjusts effective risk from ${risk.riskLevel} to ${effectiveRisk} for ramp purposes.`);
  }

  if (effectiveRisk === "HIGH") {
    const base = previousTarget ?? dayProgression;
    recommended = Math.max(0, Math.floor(base / 2));
    reasons.push("Risk level is HIGH — recommended volume reduced from the previous day rather than increased.");
  } else if (effectiveRisk === "MEDIUM") {
    const base = previousTarget ?? profile.startingDailyVolume;
    recommended = Math.min(dayProgression, base + Math.ceil(step / 2));
    reasons.push("Risk level is MEDIUM — progressing at half the normal ramp rate.");
  } else {
    recommended = dayProgression;
    reasons.push(`Normal ${profile.rampStrategy.toLowerCase()} ramp progression for warmup day ${currentDay}.`);
  }

  if (eligibility.decision === "CONDITIONALLY_ELIGIBLE") {
    reasons.push("Mailbox is conditionally eligible.", ...eligibility.reasons);
  }
  if (health.domain !== "HEALTHY") {
    reasons.push("Domain authentication is not fully healthy.");
  }

  recommended = Math.max(0, Math.min(recommended, hardCeiling));
  const maximum = hardCeiling;
  const minimum = effectiveRisk === "LOW" ? Math.floor(recommended * 0.5) : 0;

  if (recommended < dayProgression) {
    reasons.push(`Bounded below the unadjusted day-based progression of ${dayProgression} by risk/capacity.`);
  }
  if (hardCeiling < dayProgression) {
    reasons.push(`Capped at ${hardCeiling} by profile/capacity maximum.`);
  }

  const confidence = effectiveRisk === "LOW" && eligibility.decision === "ELIGIBLE" ? capacity.confidence : downgradeConfidence(capacity.confidence);

  return { minimum, recommended, maximum, confidence, reasons };
}

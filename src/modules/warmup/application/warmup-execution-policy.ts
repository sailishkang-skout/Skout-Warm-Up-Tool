import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { CapacityRecommendation } from "../../policy/domain/capacity-recommendation.js";
import type { WarmupEligibilityAssessment } from "../../policy/domain/warmup-eligibility.js";
import type { RiskAssessment } from "../../risk/domain/risk-assessment.js";
import type { DailyWarmupTarget } from "../domain/daily-warmup-target.js";
import type { WarmupDecisionOutcome, WarmupDecisionReasonCode } from "../domain/warmup-decision.js";
import type { WarmupState } from "../domain/warmup-state.js";
import { calculateWarmupTarget, type RampPolicyProfileInput } from "./ramp-policy.js";
import { evaluateSafetyGate } from "./safety-gate.js";

export interface WarmupExecutionPolicyInput {
  readonly sessionState: WarmupState;
  readonly currentDay: number;
  readonly previousTarget: number | undefined;
  readonly mailboxEnabled: boolean;
  readonly health: MailboxHealthAssessment;
  readonly risk: RiskAssessment;
  readonly eligibility: WarmupEligibilityAssessment;
  readonly capacity: CapacityRecommendation;
  readonly profile: RampPolicyProfileInput & { readonly pauseConditions: readonly string[] };
}

export interface WarmupExecutionDecisionResult {
  readonly decision: WarmupDecisionOutcome;
  readonly reasonCodes: readonly WarmupDecisionReasonCode[];
  readonly reasons: readonly string[];
  readonly target: DailyWarmupTarget;
}

/**
 * The one authoritative boundary Stage 8 spec section 9 requires — every
 * execution decision (API start, daily re-evaluation, worker re-check)
 * MUST call this and only this. It composes the two other pure functions
 * in this module (`calculateWarmupTarget`, `evaluateSafetyGate`) rather
 * than duplicating their logic, and never itself performs I/O.
 *
 * Decision mapping (Stage 8 spec section 8's five outcomes), evaluated in
 * this fixed priority order so exactly one outcome always applies:
 *   1. REVIEW  — eligibility itself is REQUIRES_REVIEW (not enough measured yet).
 *   2. PAUSE   — CRITICAL risk, a matched profile pause condition, or the
 *      session is already in COOLDOWN. These are session-level conditions
 *      a caller should act on by pausing the whole session, not just
 *      skipping one send.
 *   3. BLOCK   — a hard, current blocker (NOT_ELIGIBLE, disconnected,
 *      unauthenticated, send-incapable, session not ACTIVE, profile
 *      inactive). The session itself may still be ACTIVE; only this
 *      specific execution is blocked.
 *   4. REDUCE  — volume genuinely came down from the prior day (risk
 *      HIGH/MEDIUM in `calculateWarmupTarget`), but nothing categorically
 *      blocks sending at the reduced volume.
 *   5. PROCEED — everything checked is healthy and volume did not decrease.
 */
export function decideWarmupExecution(input: WarmupExecutionPolicyInput): WarmupExecutionDecisionResult {
  const target = calculateWarmupTarget({
    currentDay: input.currentDay,
    previousTarget: input.previousTarget,
    capacity: input.capacity,
    risk: input.risk,
    eligibility: input.eligibility,
    health: input.health,
    profile: input.profile,
  });

  const gate = evaluateSafetyGate({
    sessionState: input.sessionState,
    mailboxEnabled: input.mailboxEnabled,
    health: input.health,
    riskLevel: input.risk.riskLevel,
    eligibility: input.eligibility.decision,
    recommendedVolume: target.recommended,
    maximumVolume: target.maximum,
    profileActive: input.profile.active,
    pauseConditions: input.profile.pauseConditions,
  });

  if (input.eligibility.decision === "REQUIRES_REVIEW") {
    return { decision: "REVIEW", reasonCodes: ["REQUIRES_REVIEW"], reasons: [...target.reasons, ...gate.reasons], target };
  }

  const pauseCodes: WarmupDecisionReasonCode[] = ["RISK_CRITICAL", "PAUSE_CONDITION_MATCHED", "COOLDOWN_ACTIVE"];
  if (gate.reasonCodes.some((code) => pauseCodes.includes(code))) {
    return {
      decision: "PAUSE",
      reasonCodes: gate.reasonCodes.filter((code) => pauseCodes.includes(code)),
      reasons: [...gate.reasons, ...target.reasons],
      target,
    };
  }

  if (!gate.passed) {
    return { decision: "BLOCK", reasonCodes: gate.reasonCodes, reasons: [...gate.reasons, ...target.reasons], target };
  }

  const decreased = input.previousTarget !== undefined && target.recommended < input.previousTarget;
  if (decreased) {
    return { decision: "REDUCE", reasonCodes: ["RISK_INCREASED", "CAPACITY_REDUCED"], reasons: target.reasons, target };
  }

  return { decision: "PROCEED", reasonCodes: ["RAMP_PROGRESSION"], reasons: target.reasons, target };
}

import type { EligibilityDecision } from "../../policy/domain/warmup-eligibility.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";
import type { HealthSnapshotId, MailboxId, TenantId, WarmupDecisionId, WarmupSessionId } from "../../../shared/types/index.js";

export const WARMUP_DECISIONS = ["PROCEED", "REDUCE", "PAUSE", "BLOCK", "REVIEW"] as const;
export type WarmupDecisionOutcome = (typeof WARMUP_DECISIONS)[number];

/**
 * A stable, machine-readable reason code alongside the human-readable
 * `reasons` string — same pattern as `risk`'s `RiskFactor.code` (Stage 7).
 */
export const WARMUP_DECISION_REASON_CODES = [
  "NOT_ELIGIBLE",
  "REQUIRES_REVIEW",
  "RISK_CRITICAL",
  "RISK_HIGH",
  "RISK_INCREASED",
  "HEALTH_DEGRADED",
  "PROVIDER_DISCONNECTED",
  "SEND_CAPABILITY_UNHEALTHY",
  "CAPACITY_REDUCED",
  "PROFILE_INACTIVE",
  "PAUSE_CONDITION_MATCHED",
  "COOLDOWN_ACTIVE",
  "SESSION_NOT_ACTIVE",
  "RAMP_PROGRESSION",
] as const;
export type WarmupDecisionReasonCode = (typeof WARMUP_DECISION_REASON_CODES)[number];

/**
 * The one authoritative, explainable output of
 * `application/warmup-execution-policy.ts` (Stage 8 spec section 8/9) — the
 * only thing an execution intent may ever be created from. Append-only
 * (migrations/014_create_warmup_decisions.sql): every decision, including
 * every REDUCE/PAUSE/BLOCK, is kept forever so "why was this mailbox
 * paused" is always answerable.
 *
 * `assessmentId` ties this decision back to the exact `AssessmentSnapshot`
 * (health module) it was computed from — `profileSnapshot` captures the
 * warmup-profile fields that mattered at the time (Stage 8 spec section
 * 23), so a later profile edit can never silently reinterpret a historical
 * decision.
 */
export interface WarmupDecision {
  readonly id: WarmupDecisionId;
  readonly tenantId: TenantId;
  readonly sessionId: WarmupSessionId;
  readonly mailboxId: MailboxId;
  readonly warmupDay: number;
  readonly decision: WarmupDecisionOutcome;
  readonly reasonCodes: readonly WarmupDecisionReasonCode[];
  readonly reasons: readonly string[];
  readonly recommendedVolume: number;
  readonly maximumVolume: number;
  readonly riskLevel: RiskLevel;
  readonly eligibility: EligibilityDecision;
  readonly assessmentId?: HealthSnapshotId;
  readonly profileSnapshot: WarmupDecisionProfileSnapshot;
  readonly generatedAt: Date;
  readonly createdAt: Date;
}

/** Immutable configuration snapshot — Stage 8 spec section 23. Only the fields the ramp policy actually reads. */
export interface WarmupDecisionProfileSnapshot {
  readonly targetDailyVolume: number;
  readonly startingDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly rampStrategy: string;
  readonly riskTolerance: string;
  readonly active: boolean;
  readonly pauseConditions: readonly string[];
}

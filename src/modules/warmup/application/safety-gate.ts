import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { EligibilityDecision } from "../../policy/domain/warmup-eligibility.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";
import type { WarmupDecisionReasonCode } from "../domain/warmup-decision.js";
import type { WarmupState } from "../domain/warmup-state.js";

export interface SafetyGateInput {
  readonly sessionState: WarmupState;
  readonly mailboxEnabled: boolean;
  readonly health: MailboxHealthAssessment;
  readonly riskLevel: RiskLevel;
  readonly eligibility: EligibilityDecision;
  readonly recommendedVolume: number;
  readonly maximumVolume: number;
  readonly profileActive: boolean;
  readonly pauseConditions: readonly string[];
  /** Whether the mailbox's provider currently exposes a real send capability (Stage 9 spec section 10) — from `ProviderCapabilities.canSend`, never a hardcoded per-provider assumption. */
  readonly providerCanSend: boolean;
}

export interface SafetyGateResult {
  readonly passed: boolean;
  readonly reasonCodes: readonly WarmupDecisionReasonCode[];
  readonly reasons: readonly string[];
}

/**
 * Every mandatory condition from Stage 8 spec section 10, evaluated
 * together and pure — no I/O. This is called from two places
 * (`warmup-execution-policy.ts` when a decision is generated, and the
 * execution worker immediately before calling the provider port) with
 * freshly-fetched inputs each time; it never trusts a previously-computed
 * result (Stage 8 spec section 16/17: "State can change between scheduling
 * and execution").
 *
 * Collects every failing condition rather than stopping at the first, so a
 * blocked decision's `reasons` is always a complete explanation, not just
 * the first thing that happened to fail.
 */
export function evaluateSafetyGate(input: SafetyGateInput): SafetyGateResult {
  const codes: WarmupDecisionReasonCode[] = [];
  const reasons: string[] = [];

  if (input.sessionState === "COOLDOWN") {
    codes.push("COOLDOWN_ACTIVE");
    reasons.push("Warmup session is in a cooldown period.");
  } else if (input.sessionState !== "ACTIVE") {
    codes.push("SESSION_NOT_ACTIVE");
    reasons.push(`Warmup session is not ACTIVE (currently ${input.sessionState}).`);
  }

  if (!input.profileActive) {
    codes.push("PROFILE_INACTIVE");
    reasons.push("Warmup profile is not active.");
  }

  if (input.eligibility === "NOT_ELIGIBLE") {
    codes.push("NOT_ELIGIBLE");
    reasons.push("Mailbox is not eligible for warmup.");
  } else if (input.eligibility === "REQUIRES_REVIEW") {
    codes.push("REQUIRES_REVIEW");
    reasons.push("Eligibility requires review.");
  }

  if (input.riskLevel === "CRITICAL") {
    codes.push("RISK_CRITICAL");
    reasons.push("Risk level is CRITICAL.");
  } else if (input.riskLevel === "HIGH") {
    codes.push("RISK_HIGH");
    reasons.push("Risk level is HIGH.");
  }

  if (!input.mailboxEnabled || input.health.connection !== "HEALTHY") {
    codes.push("PROVIDER_DISCONNECTED");
    reasons.push("Mailbox is disabled or disconnected from its provider.");
  }
  if (input.health.authentication !== "HEALTHY") {
    reasons.push("Provider authentication is not healthy.");
  }
  if (input.health.sending !== "HEALTHY") {
    codes.push("SEND_CAPABILITY_UNHEALTHY");
    reasons.push("Send capability is not healthy.");
  }
  if (!input.providerCanSend) {
    codes.push("PROVIDER_SEND_UNAVAILABLE");
    reasons.push("This provider does not currently support sending.");
  }

  if (input.pauseConditions.includes("RISK_CRITICAL") && input.riskLevel === "CRITICAL") {
    codes.push("PAUSE_CONDITION_MATCHED");
    reasons.push("Profile pause condition 'RISK_CRITICAL' is currently matched.");
  }
  if (input.pauseConditions.includes("PROVIDER_DISCONNECTED") && input.health.connection !== "HEALTHY") {
    codes.push("PAUSE_CONDITION_MATCHED");
    reasons.push("Profile pause condition 'PROVIDER_DISCONNECTED' is currently matched.");
  }

  if (input.recommendedVolume <= 0) {
    reasons.push("Recommended volume is zero.");
  }
  if (input.recommendedVolume > input.maximumVolume) {
    reasons.push("Recommended volume exceeds the maximum bound — this indicates a policy bug, not a mailbox condition.");
  }

  // RISK_HIGH is informational only, never a hard blocker: HIGH risk is
  // the ramp policy's job to reduce (decision REDUCE), not this gate's job
  // to block (Stage 8 spec section 7/8 — HIGH risk "reduce", CRITICAL
  // "pause"/BLOCK). Every other collected code IS a hard blocker.
  const blockingCodes = codes.filter((code) => code !== "RISK_HIGH");

  const passed =
    blockingCodes.length === 0 &&
    input.recommendedVolume > 0 &&
    input.recommendedVolume <= input.maximumVolume &&
    input.health.authentication === "HEALTHY";

  return { passed, reasonCodes: [...new Set(codes)], reasons };
}

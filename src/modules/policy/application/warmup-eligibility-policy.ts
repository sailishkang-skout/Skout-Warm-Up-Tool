import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { RiskAssessment } from "../../risk/domain/risk-assessment.js";
import type { WarmupEligibilityAssessment } from "../domain/warmup-eligibility.js";

export interface EligibilityPolicyInput {
  readonly health: MailboxHealthAssessment;
  readonly risk: RiskAssessment;
  readonly mailboxEnabled: boolean;
}

/**
 * The one authoritative eligibility boundary (Stage 7 spec section 11) —
 * pure and deterministic (section 23), consumed by API routes and, later,
 * a warmup scheduler; neither is allowed to re-derive eligibility from raw
 * health/risk fields itself.
 *
 * Decision priority, evaluated in order:
 *   1. REQUIRES_REVIEW  — not enough has been measured yet to decide safely
 *      (risk or core connection/auth health is still UNKNOWN).
 *   2. NOT_ELIGIBLE      — a clear, current blocker: disabled, disconnected,
 *      unauthenticated, or CRITICAL risk.
 *   3. REQUIRES_REVIEW  — HIGH risk with no single disqualifying blocker;
 *      warrants a human look rather than an automatic yes/no.
 *   4. CONDITIONALLY_ELIGIBLE — core connectivity is healthy but something
 *      short of a blocker needs attention (MEDIUM risk, domain/sending/
 *      receiving not fully healthy).
 *   5. ELIGIBLE          — everything checked is healthy and risk is LOW.
 */
export function evaluateEligibility(input: EligibilityPolicyInput, assessedAt: Date): WarmupEligibilityAssessment {
  const { health, risk, mailboxEnabled } = input;
  const reasons: string[] = [];

  if (risk.riskLevel === "UNKNOWN" || health.connection === "UNKNOWN" || health.authentication === "UNKNOWN") {
    reasons.push("Not enough has been measured yet to make a confident eligibility decision.");
    if (health.connection === "UNKNOWN") reasons.push("Connection health has not been established.");
    if (health.authentication === "UNKNOWN") reasons.push("Authentication health has not been established.");
    return { decision: "REQUIRES_REVIEW", reasons, assessedAt };
  }

  if (!mailboxEnabled) {
    reasons.push("Mailbox is administratively disabled.");
  }
  if (health.connection === "UNHEALTHY") {
    reasons.push("Mailbox is disconnected from its provider.");
  }
  if (health.authentication === "UNHEALTHY") {
    reasons.push("Provider authentication is unhealthy.");
  }
  if (risk.riskLevel === "CRITICAL") {
    reasons.push("Overall risk level is CRITICAL.");
  }
  if (reasons.length > 0) {
    return { decision: "NOT_ELIGIBLE", reasons, assessedAt };
  }

  if (risk.riskLevel === "HIGH") {
    return {
      decision: "REQUIRES_REVIEW",
      reasons: ["Overall risk level is HIGH and warrants review before starting warmup."],
      assessedAt,
    };
  }

  const conditionalReasons: string[] = [];
  if (risk.riskLevel === "MEDIUM") {
    conditionalReasons.push("Overall risk level is MEDIUM.");
  }
  if (health.domain !== "HEALTHY") {
    conditionalReasons.push(
      health.domain === "UNKNOWN"
        ? "Domain authentication (SPF/DKIM/DMARC/MX) has not been checked yet."
        : "Domain authentication (SPF/DKIM/DMARC/MX) is not fully configured.",
    );
  }
  if (health.sending !== "HEALTHY") {
    conditionalReasons.push("Send capability is not fully healthy.");
  }
  if (health.receiving !== "HEALTHY") {
    conditionalReasons.push("Receive capability is not fully healthy.");
  }
  if (conditionalReasons.length > 0) {
    return { decision: "CONDITIONALLY_ELIGIBLE", reasons: conditionalReasons, assessedAt };
  }

  return {
    decision: "ELIGIBLE",
    reasons: [
      "Mailbox connection is healthy.",
      "Provider authentication is healthy.",
      "Domain authentication is fully configured.",
      "Overall risk level is LOW.",
    ],
    assessedAt,
  };
}

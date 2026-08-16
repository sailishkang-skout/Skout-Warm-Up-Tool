import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { RiskAssessment, RiskFactor, RiskLevel } from "../domain/risk-assessment.js";

export interface RiskPolicyInput {
  readonly health: MailboxHealthAssessment;
  readonly domainAssessed: boolean;
}

/**
 * Configurable, documented weights (Stage 7 spec section 10: "Make weights
 * configurable and documented") — every triggered factor contributes its
 * weight toward `riskScore`; the score is capped at 100 and is a
 * *representation* of these factors, never computed independently of them.
 * Values are deliberately round numbers, not false precision.
 */
export const RISK_FACTOR_WEIGHTS = {
  PROVIDER_DISCONNECTED: 40,
  AUTHENTICATION_UNHEALTHY: 30,
  AUTHENTICATION_DEGRADED: 10,
  SEND_UNHEALTHY: 15,
  RECEIVE_UNHEALTHY: 10,
  MISSING_MX: 25,
  MISSING_SPF: 15,
  DMARC_MISSING: 10,
  MAILBOX_DISABLED: 20,
} as const;

const RISK_LEVEL_THRESHOLDS: ReadonlyArray<{ readonly minScore: number; readonly level: RiskLevel }> = [
  { minScore: 70, level: "CRITICAL" },
  { minScore: 40, level: "HIGH" },
  { minScore: 15, level: "MEDIUM" },
  { minScore: 0, level: "LOW" },
];

function scoreToLevel(score: number): RiskLevel {
  const match = RISK_LEVEL_THRESHOLDS.find((t) => score >= t.minScore);
  return match?.level ?? "LOW";
}

function factor(code: keyof typeof RISK_FACTOR_WEIGHTS, description: string, severity: RiskLevel): RiskFactor {
  return { code, description, severity };
}

/**
 * Deterministic and side-effect-free: the same `RiskPolicyInput` always
 * produces the same `RiskAssessment` (Stage 7 spec section 23) — no clock
 * reads except the caller-supplied `assessedAt`, no I/O. `UNKNOWN` is
 * returned only when there is genuinely nothing to assess yet (every
 * health dimension is `UNKNOWN` and no domain check has ever run) — not as
 * a fallback for "something went wrong."
 */
export function evaluateRisk(input: RiskPolicyInput, assessedAt: Date): RiskAssessment {
  const { health } = input;
  const riskFactors: RiskFactor[] = [];

  if (health.connection === "UNHEALTHY") {
    riskFactors.push(factor("PROVIDER_DISCONNECTED", "The mailbox is not currently connected to its provider.", "HIGH"));
  }
  if (health.authentication === "UNHEALTHY") {
    riskFactors.push(factor("AUTHENTICATION_UNHEALTHY", "The provider rejected the stored credential.", "HIGH"));
  } else if (health.authentication === "DEGRADED") {
    riskFactors.push(factor("AUTHENTICATION_DEGRADED", "Provider authentication is degraded.", "MEDIUM"));
  }
  if (health.sending === "UNHEALTHY") {
    riskFactors.push(factor("SEND_UNHEALTHY", "The mailbox cannot currently send mail.", "MEDIUM"));
  }
  if (health.receiving === "UNHEALTHY") {
    riskFactors.push(factor("RECEIVE_UNHEALTHY", "The mailbox cannot currently receive mail.", "LOW"));
  }
  if (input.domainAssessed) {
    if (health.domain === "UNHEALTHY") {
      riskFactors.push(factor("MISSING_MX", "The sending domain has no valid MX records.", "HIGH"));
    } else if (health.domain === "DEGRADED") {
      riskFactors.push(factor("MISSING_SPF", "The sending domain is missing SPF and/or DMARC configuration.", "MEDIUM"));
      riskFactors.push(factor("DMARC_MISSING", "DMARC is not fully configured for the sending domain.", "LOW"));
    }
  }
  if (health.configuration === "DEGRADED") {
    riskFactors.push(factor("MAILBOX_DISABLED", "The mailbox is administratively disabled.", "MEDIUM"));
  }

  const allUnknown =
    health.connection === "UNKNOWN" &&
    health.authentication === "UNKNOWN" &&
    health.sending === "UNKNOWN" &&
    health.receiving === "UNKNOWN" &&
    !input.domainAssessed;

  if (allUnknown) {
    return { riskLevel: "UNKNOWN", riskScore: 0, riskFactors: [], assessedAt };
  }

  const rawScore = riskFactors.reduce((total, f) => total + RISK_FACTOR_WEIGHTS[f.code as keyof typeof RISK_FACTOR_WEIGHTS], 0);
  const riskScore = Math.min(100, rawScore);

  return { riskLevel: scoreToLevel(riskScore), riskScore, riskFactors, assessedAt };
}

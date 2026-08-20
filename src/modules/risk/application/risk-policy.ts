import type { MailboxHealthAssessment } from "../../health/domain/mailbox-health.js";
import type { ReputationAssessment } from "../../reputation/domain/reputation-assessment.js";
import type { RiskAssessment, RiskFactor, RiskLevel } from "../domain/risk-assessment.js";

export interface RiskPolicyInput {
  readonly health: MailboxHealthAssessment;
  readonly domainAssessed: boolean;
  /**
   * Stage 10 spec section 10: "extend the existing RiskPolicy... add
   * reputation-derived risk factors." Optional so every pre-Stage-10 caller
   * (and every existing unit test) keeps working unchanged — omitting it
   * simply means no reputation-derived factors are considered, never an
   * error. `reputation` remains the sole authority for delivery-evidence
   * reputation; this policy only ever *reads* its `factors`, never
   * recomputes or second-guesses them.
   */
  readonly reputation?: ReputationAssessment;
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
  /**
   * Stage 10 spec section 10 — reputation-derived factors, calibrated
   * deliberately conservatively: no single one of these alone reaches the
   * CRITICAL threshold (70). "CRITICAL should require strong evidence"
   * (section 10) — reaching CRITICAL from reputation alone requires
   * multiple corroborating factors (e.g. a high bounce rate *and* a
   * degrading trend), never one noisy signal.
   * `HIGH_HARD_BOUNCE_RATE` is reserved but never triggered today —
   * `reputation`'s normalized event taxonomy has no hard/soft bounce
   * split yet (see reputation/application/reputation-policy.ts), so this
   * codebase never fabricates that distinction.
   */
  HIGH_BOUNCE_RATE: 30,
  HIGH_HARD_BOUNCE_RATE: 35,
  HIGH_THROTTLE_RATE: 25,
  HIGH_PROVIDER_REJECTION_RATE: 30,
  HIGH_FAILURE_RATE: 30,
  COMPLAINT_SIGNAL: 35,
  DEGRADING_DELIVERY_TREND: 10,
  DEGRADING_BOUNCE_TREND: 10,
  DEGRADING_PROVIDER_TREND: 10,
  /**
   * Stage 11 spec section 6 — provider-scoped and domain-scoped reputation
   * factors (aggregated across every mailbox this tenant sends through that
   * provider/domain, see `reputation/domain/reputation-assessment.ts`'s
   * `ProviderReputationSnapshot`/`DomainReputationSnapshot`). Weighted at
   * roughly half the mailbox-level equivalent above: this evidence is
   * genuinely relevant context (a provider-wide or domain-wide delivery
   * problem is real signal) but is one step removed from "this specific
   * mailbox is unsafe" — a mailbox with a perfectly clean history sharing a
   * struggling provider/domain should see elevated risk, but never as much
   * as if the problem were its own. Every single value here (max 15) is
   * nowhere near the CRITICAL threshold (70) alone — "no single weak
   * provider/domain signal can independently force CRITICAL" (Stage 11
   * spec section 6) — reaching CRITICAL from provider/domain evidence alone
   * still requires several corroborating factors, exactly like mailbox-level
   * reputation already does.
   */
  PROVIDER_HIGH_BOUNCE_RATE: 15,
  PROVIDER_HIGH_HARD_BOUNCE_RATE: 15,
  PROVIDER_HIGH_THROTTLE_RATE: 15,
  PROVIDER_HIGH_PROVIDER_REJECTION_RATE: 15,
  PROVIDER_HIGH_FAILURE_RATE: 15,
  PROVIDER_COMPLAINT_SIGNAL: 15,
  PROVIDER_DEGRADING_DELIVERY_TREND: 5,
  PROVIDER_DEGRADING_BOUNCE_TREND: 5,
  PROVIDER_DEGRADING_PROVIDER_TREND: 5,
  DOMAIN_HIGH_BOUNCE_RATE: 15,
  DOMAIN_HIGH_HARD_BOUNCE_RATE: 15,
  DOMAIN_HIGH_THROTTLE_RATE: 15,
  DOMAIN_HIGH_PROVIDER_REJECTION_RATE: 15,
  DOMAIN_HIGH_FAILURE_RATE: 15,
  DOMAIN_COMPLAINT_SIGNAL: 15,
  DOMAIN_DEGRADING_DELIVERY_TREND: 5,
  DOMAIN_DEGRADING_BOUNCE_TREND: 5,
  DOMAIN_DEGRADING_PROVIDER_TREND: 5,
} as const;

/** Base reputation factor codes (unprefixed) — mirrored with `PROVIDER_`/`DOMAIN_` prefixes below for the two Stage 11 aggregation scopes, so the allowlist is never hand-duplicated three times. */
const REPUTATION_FACTOR_BASE_CODES = [
  "HIGH_BOUNCE_RATE",
  "HIGH_HARD_BOUNCE_RATE",
  "HIGH_THROTTLE_RATE",
  "HIGH_PROVIDER_REJECTION_RATE",
  "HIGH_FAILURE_RATE",
  "COMPLAINT_SIGNAL",
  "DEGRADING_DELIVERY_TREND",
  "DEGRADING_BOUNCE_TREND",
  "DEGRADING_PROVIDER_TREND",
] as const;

/** Reputation's own factor codes this policy recognizes and re-weights as risk factors — everything else on a `ReputationAssessment` is ignored here (Stage 10 spec section 10: risk only ever reads reputation's `factors`, never its raw window evidence). */
const REPUTATION_RISK_FACTOR_CODES: ReadonlySet<string> = new Set(REPUTATION_FACTOR_BASE_CODES);
/** Stage 11: `ProviderReputationSnapshot.factors` codes. */
const PROVIDER_REPUTATION_RISK_FACTOR_CODES: ReadonlySet<string> = new Set(REPUTATION_FACTOR_BASE_CODES.map((code) => `PROVIDER_${code}`));
/** Stage 11: `DomainReputationSnapshot.factors` codes. */
const DOMAIN_REPUTATION_RISK_FACTOR_CODES: ReadonlySet<string> = new Set(REPUTATION_FACTOR_BASE_CODES.map((code) => `DOMAIN_${code}`));

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

  // Stage 10 spec section 10: only factors reputation itself already
  // computed and gated behind its own evidence-window thresholds are
  // re-weighted here — this policy never re-derives a rate or a trend from
  // raw delivery events itself, it only reads reputation's conclusions.
  if (input.reputation) {
    for (const reputationFactor of input.reputation.factors) {
      if (REPUTATION_RISK_FACTOR_CODES.has(reputationFactor.code)) {
        riskFactors.push(factor(reputationFactor.code as keyof typeof RISK_FACTOR_WEIGHTS, reputationFactor.description, reputationFactor.severity));
      }
    }
    // Stage 11 spec section 6/7: provider/domain evidence flows into the
    // same existing risk boundary, never a second engine — read here
    // exactly like mailbox-level factors above, just gated by their own
    // (lower-weighted) allowlist.
    for (const providerFactor of input.reputation.providerReputation.factors) {
      if (PROVIDER_REPUTATION_RISK_FACTOR_CODES.has(providerFactor.code)) {
        riskFactors.push(factor(providerFactor.code as keyof typeof RISK_FACTOR_WEIGHTS, providerFactor.description, providerFactor.severity));
      }
    }
    for (const domainFactor of input.reputation.domainReputation.factors) {
      if (DOMAIN_REPUTATION_RISK_FACTOR_CODES.has(domainFactor.code)) {
        riskFactors.push(factor(domainFactor.code as keyof typeof RISK_FACTOR_WEIGHTS, domainFactor.description, domainFactor.severity));
      }
    }
  }

  const healthAllUnknown =
    health.connection === "UNKNOWN" &&
    health.authentication === "UNKNOWN" &&
    health.sending === "UNKNOWN" &&
    health.receiving === "UNKNOWN" &&
    !input.domainAssessed;
  const reputationKnown =
    input.reputation !== undefined &&
    (input.reputation.status !== "UNKNOWN" || input.reputation.providerReputation.status !== "UNKNOWN" || input.reputation.domainReputation.status !== "UNKNOWN");
  const allUnknown = healthAllUnknown && !reputationKnown;

  if (allUnknown) {
    return { riskLevel: "UNKNOWN", riskScore: 0, riskFactors: [], assessedAt };
  }

  const rawScore = riskFactors.reduce((total, f) => total + RISK_FACTOR_WEIGHTS[f.code as keyof typeof RISK_FACTOR_WEIGHTS], 0);
  const riskScore = Math.min(100, rawScore);

  return { riskLevel: scoreToLevel(riskScore), riskScore, riskFactors, assessedAt };
}

import type { HealthStatus, MailboxHealthAssessment } from "../domain/mailbox-health.js";
import type { Signal, SignalType } from "../domain/signal.js";

function findLatestSignal(signals: readonly Signal[], type: SignalType): Signal | undefined {
  return signals
    .filter((s) => s.type === type)
    .sort((a, b) => b.evidence.observedAt.getTime() - a.evidence.observedAt.getTime())[0];
}

function booleanHealth(signal: Signal | undefined): HealthStatus {
  if (!signal) {
    return "UNKNOWN";
  }
  return signal.value === true ? "HEALTHY" : "UNHEALTHY";
}

const PROVIDER_HEALTH_TO_HEALTH_STATUS: Record<string, HealthStatus> = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  UNAVAILABLE: "UNHEALTHY",
  UNAUTHENTICATED: "UNHEALTHY",
  UNKNOWN: "UNKNOWN",
};

function providerAuthHealth(signal: Signal | undefined): HealthStatus {
  if (!signal || typeof signal.value !== "string") {
    return "UNKNOWN";
  }
  return PROVIDER_HEALTH_TO_HEALTH_STATUS[signal.value] ?? "UNKNOWN";
}

/**
 * Domain health considers MX and SPF/DMARC, deliberately not DKIM: DKIM
 * discovery only tries a handful of common selectors
 * (`domain-intelligence`'s `COMMON_DKIM_SELECTORS`), so a `MISSING` result
 * there is a much weaker signal (likely false negative) than `MISSING` for
 * MX/SPF/DMARC, which are checked at their one fixed, unambiguous location.
 * Letting DKIM downgrade domain health would punish correctly-configured
 * domains whose selector this service simply doesn't know to try.
 */
function domainHealth(
  mxSignal: Signal | undefined,
  spfSignal: Signal | undefined,
  dmarcSignal: Signal | undefined,
): HealthStatus {
  if (!mxSignal) {
    return "UNKNOWN";
  }
  if (mxSignal.value !== "PASS") {
    return "UNHEALTHY";
  }
  const spfOk = spfSignal?.value === "PASS";
  const dmarcOk = dmarcSignal?.value === "PASS";
  return spfOk && dmarcOk ? "HEALTHY" : "DEGRADED";
}

/**
 * Pure — no I/O, no clock reads beyond `assessedAt`. Takes whatever signals
 * `application/signal-collector.ts` (or a test) hands it and produces the
 * six-dimension assessment `mailbox-health.ts` defines. A signal type this
 * function doesn't find in `signals` simply yields `UNKNOWN` for that
 * dimension — never a guess.
 */
export function evaluateHealth(signals: readonly Signal[], configurationEnabled: boolean, assessedAt: Date): MailboxHealthAssessment {
  return {
    connection: booleanHealth(findLatestSignal(signals, "PROVIDER_CONNECTED")),
    authentication: providerAuthHealth(findLatestSignal(signals, "PROVIDER_AUTHENTICATED")),
    sending: booleanHealth(findLatestSignal(signals, "SEND_CAPABLE")),
    receiving: booleanHealth(findLatestSignal(signals, "RECEIVE_CAPABLE")),
    domain: domainHealth(
      findLatestSignal(signals, "DOMAIN_MX"),
      findLatestSignal(signals, "DOMAIN_SPF"),
      findLatestSignal(signals, "DOMAIN_DMARC"),
    ),
    configuration: configurationEnabled ? "HEALTHY" : "DEGRADED",
    assessedAt,
  };
}

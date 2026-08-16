import type { DomainAuthenticationAssessment } from "../../domain-intelligence/domain/domain-authentication.js";
import type { MailboxStatus } from "../../mailbox/domain/mailbox.js";
import type { ConnectionHealthSnapshot } from "../../mailbox/application/mailbox-service.js";
import type { Signal } from "../domain/signal.js";

export interface CollectSignalsInput {
  readonly mailboxStatus: MailboxStatus;
  readonly connectionHealth: ConnectionHealthSnapshot;
  readonly domainAssessment: DomainAuthenticationAssessment | undefined;
  readonly observedAt: Date;
}

/**
 * Pure — normalizes already-collected data (a live provider connection
 * check, a domain check) into typed `Signal`s. It performs no I/O itself;
 * `MailboxAssessmentService.refreshAssessment` is what actually calls
 * `MailboxService.getConnectionHealth`/`DomainIntelligenceService.getAssessment`
 * before handing the results here. Keeping normalization separate from
 * collection is what makes it directly unit-testable (Stage 7 spec section
 * 27: "signal normalization") without a database, Redis, or a real
 * provider/DNS call.
 */
export function collectSignals(input: CollectSignalsInput): Signal[] {
  const { mailboxStatus, connectionHealth, domainAssessment, observedAt } = input;
  const signals: Signal[] = [];

  signals.push({
    type: "PROVIDER_CONNECTED",
    value: mailboxStatus === "CONNECTED",
    evidence: { source: "mailbox.status", observedAt, confidence: "HIGH", metadata: { mailboxStatus } },
  });

  signals.push({
    type: "PROVIDER_AUTHENTICATED",
    value: connectionHealth.authenticationStatus,
    evidence: {
      source: "provider.getConnectionHealth",
      observedAt: connectionHealth.checkedAt,
      confidence: connectionHealth.authenticationStatus === "UNKNOWN" ? "LOW" : "HIGH",
    },
  });

  signals.push({
    type: "SEND_CAPABLE",
    value: connectionHealth.sendCapability,
    evidence: { source: "provider.getConnectionHealth", observedAt: connectionHealth.checkedAt, confidence: "HIGH" },
  });

  signals.push({
    type: "RECEIVE_CAPABLE",
    value: connectionHealth.receiveCapability,
    evidence: { source: "provider.getConnectionHealth", observedAt: connectionHealth.checkedAt, confidence: "HIGH" },
  });

  if (domainAssessment) {
    signals.push({
      type: "DOMAIN_MX",
      value: domainAssessment.mx.status,
      evidence: {
        source: "dns.resolveMx",
        observedAt: domainAssessment.checkedAt,
        confidence: "HIGH",
        metadata: { recordCount: domainAssessment.mx.records.length },
      },
    });
    signals.push({
      type: "DOMAIN_SPF",
      value: domainAssessment.spf.status,
      evidence: { source: "dns.resolveTxt", observedAt: domainAssessment.checkedAt, confidence: "HIGH" },
    });
    signals.push({
      type: "DOMAIN_DKIM",
      value: domainAssessment.dkim.status,
      // MEDIUM, not HIGH: a common-selector guess that finds nothing is a
      // much weaker signal than one that finds something (see
      // mailbox-health-evaluator.ts's identical reasoning for why DKIM
      // doesn't gate domain health).
      evidence: {
        source: "dns.resolveTxt",
        observedAt: domainAssessment.checkedAt,
        confidence: domainAssessment.dkim.status === "PASS" ? "HIGH" : "MEDIUM",
        ...(domainAssessment.dkim.selector ? { metadata: { selector: domainAssessment.dkim.selector } } : {}),
      },
    });
    signals.push({
      type: "DOMAIN_DMARC",
      value: domainAssessment.dmarc.status,
      evidence: {
        source: "dns.resolveTxt",
        observedAt: domainAssessment.checkedAt,
        confidence: "HIGH",
        ...(domainAssessment.dmarc.policy ? { metadata: { policy: domainAssessment.dmarc.policy } } : {}),
      },
    });
  }

  return signals;
}

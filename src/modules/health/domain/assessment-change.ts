import type { AssessmentSnapshot } from "./assessment-snapshot.js";

/**
 * One normalized, meaningful change between two assessments (Stage 7 spec
 * section 18: "DMARC PASS → FAIL", "connected → disconnected", "LOW risk →
 * HIGH risk", "eligible → not eligible"). Not a generic diff of every
 * field — only the fields a human or a future notification system would
 * actually care about are compared (see `detectChanges` below).
 */
export interface AssessmentChange {
  readonly field: string;
  readonly previousValue: string;
  readonly newValue: string;
}

function compare(field: string, previous: string, next: string): AssessmentChange | undefined {
  return previous === next ? undefined : { field, previousValue: previous, newValue: next };
}

/**
 * Pure and deterministic — same two snapshots always produce the same
 * change list, no I/O. `previous` is `undefined` for a mailbox's very
 * first assessment, in which case there is nothing to compare against and
 * this returns no changes (a first assessment is not a "change").
 *
 * Deliberately does not send or queue a notification — Stage 7 spec
 * section 18: "Do not implement notifications yet." This only detects.
 */
export function detectChanges(
  previous: AssessmentSnapshot | undefined,
  current: AssessmentSnapshot,
): readonly AssessmentChange[] {
  if (!previous) {
    return [];
  }

  const changes: AssessmentChange[] = [];
  const record = (change: AssessmentChange | undefined) => {
    if (change) {
      changes.push(change);
    }
  };

  record(compare("riskLevel", previous.risk.riskLevel, current.risk.riskLevel));
  record(compare("eligibilityDecision", previous.eligibility.decision, current.eligibility.decision));
  record(compare("health.connection", previous.health.connection, current.health.connection));
  record(compare("health.authentication", previous.health.authentication, current.health.authentication));
  record(compare("health.sending", previous.health.sending, current.health.sending));
  record(compare("health.receiving", previous.health.receiving, current.health.receiving));
  record(compare("health.domain", previous.health.domain, current.health.domain));
  record(compare("health.configuration", previous.health.configuration, current.health.configuration));

  if (previous.domainAssessment && current.domainAssessment) {
    record(compare("domain.mx", previous.domainAssessment.mx.status, current.domainAssessment.mx.status));
    record(compare("domain.spf", previous.domainAssessment.spf.status, current.domainAssessment.spf.status));
    record(compare("domain.dkim", previous.domainAssessment.dkim.status, current.domainAssessment.dkim.status));
    record(compare("domain.dmarc", previous.domainAssessment.dmarc.status, current.domainAssessment.dmarc.status));
  }

  return changes;
}

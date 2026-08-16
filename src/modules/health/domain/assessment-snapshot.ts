import type { DomainAuthenticationAssessment } from "../../domain-intelligence/domain/domain-authentication.js";
import type { HealthSnapshotId, MailboxId, TenantId } from "../../../shared/types/index.js";
import type { CapacityRecommendation } from "../../policy/domain/capacity-recommendation.js";
import type { WarmupEligibilityAssessment } from "../../policy/domain/warmup-eligibility.js";
import type { RiskAssessment } from "../../risk/domain/risk-assessment.js";
import type { MailboxHealthAssessment } from "./mailbox-health.js";

/**
 * The persisted, point-in-time output of one full
 * `MailboxAssessmentService.refreshAssessment` run — health, risk,
 * eligibility, and capacity computed together from the same signal set so
 * they can never disagree about what was known at that moment. Append-only
 * (migrations/011_create_mailbox_assessments.sql): history
 * (application/mailbox-assessment-repository.ts) and change detection
 * (assessment-change.ts) both depend on every prior snapshot surviving.
 */
export interface AssessmentSnapshot {
  readonly id: HealthSnapshotId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly health: MailboxHealthAssessment;
  readonly risk: RiskAssessment;
  readonly eligibility: WarmupEligibilityAssessment;
  readonly capacity: CapacityRecommendation;
  /** The domain check this assessment was computed against, if one was available. */
  readonly domainAssessment?: DomainAuthenticationAssessment;
  readonly assessedAt: Date;
}

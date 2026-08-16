import type { MailboxId, TenantId } from "../../../shared/types/index.js";

/**
 * Stage 10 spec section 17's "lightweight mechanism... assessment
 * invalidation or reassessment-needed marker" — deliberately not a full
 * event-driven reassessment pipeline. A mailbox marked stale here is
 * recomputed the next time anything calls `MailboxAssessmentService.getAssessment`
 * (every warmup decision path already does), not synchronously when the
 * marker is set. Port implemented by
 * `infrastructure/redis-assessment-invalidation-store.ts`.
 */
export interface AssessmentInvalidationStore {
  markStale(tenantId: TenantId, mailboxId: MailboxId): Promise<void>;
  isStale(tenantId: TenantId, mailboxId: MailboxId): Promise<boolean>;
  clear(tenantId: TenantId, mailboxId: MailboxId): Promise<void>;
}

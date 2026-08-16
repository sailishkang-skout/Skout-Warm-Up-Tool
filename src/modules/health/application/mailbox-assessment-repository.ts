import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { AssessmentSnapshot } from "../domain/assessment-snapshot.js";

export interface CreateAssessmentSnapshotInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly snapshot: Omit<AssessmentSnapshot, "id" | "tenantId" | "mailboxId">;
}

/** Port implemented by `infrastructure/postgres-mailbox-assessment-repository.ts`. Append-only — see migrations/011_create_mailbox_assessments.sql. */
export interface MailboxAssessmentRepository {
  create(input: CreateAssessmentSnapshotInput): Promise<AssessmentSnapshot>;
  findLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot | undefined>;
  /** Newest first. `limit` is always applied — never an unbounded query (Stage 7 spec section 20). */
  listHistory(tenantId: TenantId, mailboxId: MailboxId, limit: number): Promise<AssessmentSnapshot[]>;
}

import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { ReputationAssessment } from "../domain/reputation-assessment.js";

export interface CreateReputationAssessmentInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly snapshot: Omit<ReputationAssessment, "id" | "tenantId" | "mailboxId" | "createdAt">;
}

/** Port implemented by `infrastructure/postgres-reputation-repository.ts`. Append-only — see migrations/019_create_reputation_assessments.sql. */
export interface ReputationRepository {
  create(input: CreateReputationAssessmentInput): Promise<ReputationAssessment>;
  findLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment | undefined>;
  /** Newest first. `limit` is always applied — never an unbounded query. */
  listHistory(tenantId: TenantId, mailboxId: MailboxId, limit: number): Promise<ReputationAssessment[]>;
}

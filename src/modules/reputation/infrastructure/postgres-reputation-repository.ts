import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asMailboxId, asReputationAssessmentId, asTenantId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { CreateReputationAssessmentInput, ReputationRepository } from "../application/reputation-repository.js";
import type {
  DomainReputationSnapshot,
  ProviderReputationSnapshot,
  ReputationAssessment,
  ReputationFactor,
  ReputationStatus,
  ReputationTrends,
  ReputationWindowEvidence,
} from "../domain/reputation-assessment.js";

interface ReputationAssessmentRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  status: ReputationStatus;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  factors: ReputationFactor[];
  trends: ReputationTrends;
  last_24h: ReputationWindowEvidence;
  last_7d: ReputationWindowEvidence;
  lifetime: ReputationWindowEvidence;
  provider_reputation: ProviderReputationSnapshot;
  domain_reputation: DomainReputationSnapshot;
  assessed_at: Date;
  created_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, status, confidence, factors, trends, last_24h, last_7d, lifetime,
  provider_reputation, domain_reputation, assessed_at, created_at
`;

function mapRow(row: ReputationAssessmentRow): ReputationAssessment {
  return {
    id: asReputationAssessmentId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    status: row.status,
    confidence: row.confidence,
    factors: row.factors,
    trends: row.trends,
    last24h: row.last_24h,
    last7d: row.last_7d,
    lifetime: row.lifetime,
    providerReputation: row.provider_reputation,
    domainReputation: row.domain_reputation,
    assessedAt: row.assessed_at,
    createdAt: row.created_at,
  };
}

export class PostgresReputationRepository implements ReputationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateReputationAssessmentInput): Promise<ReputationAssessment> {
    const rows = await this.db.query<ReputationAssessmentRow>(
      `INSERT INTO reputation_assessments
         (tenant_id, mailbox_id, status, confidence, factors, trends, last_24h, last_7d, lifetime,
          provider_reputation, domain_reputation, assessed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.snapshot.status,
        input.snapshot.confidence,
        JSON.stringify(input.snapshot.factors),
        JSON.stringify(input.snapshot.trends),
        JSON.stringify(input.snapshot.last24h),
        JSON.stringify(input.snapshot.last7d),
        JSON.stringify(input.snapshot.lifetime),
        JSON.stringify(input.snapshot.providerReputation),
        JSON.stringify(input.snapshot.domainReputation),
        input.snapshot.assessedAt,
      ],
    );
    return mapRow(expectOne(rows, "reputation_assessments insert"));
  }

  async findLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<ReputationAssessment | undefined> {
    const rows = await this.db.query<ReputationAssessmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM reputation_assessments WHERE tenant_id = $1 AND mailbox_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listHistory(tenantId: TenantId, mailboxId: MailboxId, limit: number): Promise<ReputationAssessment[]> {
    const rows = await this.db.query<ReputationAssessmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM reputation_assessments WHERE tenant_id = $1 AND mailbox_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [tenantId, mailboxId, limit],
    );
    return rows.map(mapRow);
  }
}

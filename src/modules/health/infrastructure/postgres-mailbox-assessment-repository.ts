import type { DomainAuthenticationAssessment } from "../../domain-intelligence/domain/domain-authentication.js";
import type { EligibilityDecision } from "../../policy/domain/warmup-eligibility.js";
import type { RiskFactor, RiskLevel } from "../../risk/domain/risk-assessment.js";
import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asHealthSnapshotId, asMailboxId, asTenantId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type {
  CreateAssessmentSnapshotInput,
  MailboxAssessmentRepository,
} from "../application/mailbox-assessment-repository.js";
import type { AssessmentSnapshot } from "../domain/assessment-snapshot.js";
import type { ConfidenceLevel } from "../domain/signal.js";
import type { HealthStatus } from "../domain/mailbox-health.js";

interface MailboxAssessmentRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  connection_health: HealthStatus;
  authentication_health: HealthStatus;
  sending_health: HealthStatus;
  receiving_health: HealthStatus;
  domain_health: HealthStatus;
  configuration_health: HealthStatus;
  risk_level: RiskLevel;
  risk_score: number;
  risk_factors: RiskFactor[];
  eligibility_decision: EligibilityDecision;
  eligibility_reasons: string[];
  recommended_daily_volume: number;
  minimum_daily_volume: number;
  maximum_daily_volume: number;
  capacity_confidence: ConfidenceLevel;
  capacity_reasons: string[];
  domain_assessment: DomainAuthenticationAssessment | null;
  assessed_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id,
  connection_health, authentication_health, sending_health, receiving_health, domain_health, configuration_health,
  risk_level, risk_score, risk_factors,
  eligibility_decision, eligibility_reasons,
  recommended_daily_volume, minimum_daily_volume, maximum_daily_volume, capacity_confidence, capacity_reasons,
  domain_assessment, assessed_at
`;

function mapRow(row: MailboxAssessmentRow): AssessmentSnapshot {
  return {
    id: asHealthSnapshotId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    health: {
      connection: row.connection_health,
      authentication: row.authentication_health,
      sending: row.sending_health,
      receiving: row.receiving_health,
      domain: row.domain_health,
      configuration: row.configuration_health,
      assessedAt: row.assessed_at,
    },
    risk: {
      riskLevel: row.risk_level,
      riskScore: row.risk_score,
      riskFactors: row.risk_factors,
      assessedAt: row.assessed_at,
    },
    eligibility: {
      decision: row.eligibility_decision,
      reasons: row.eligibility_reasons,
      assessedAt: row.assessed_at,
    },
    capacity: {
      recommendedDailyVolume: row.recommended_daily_volume,
      minimumDailyVolume: row.minimum_daily_volume,
      maximumDailyVolume: row.maximum_daily_volume,
      confidence: row.capacity_confidence,
      reasons: row.capacity_reasons,
      assessedAt: row.assessed_at,
    },
    ...(row.domain_assessment
      ? {
          domainAssessment: {
            ...row.domain_assessment,
            checkedAt: new Date(row.domain_assessment.checkedAt),
          },
        }
      : {}),
    assessedAt: row.assessed_at,
  };
}

export class PostgresMailboxAssessmentRepository implements MailboxAssessmentRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateAssessmentSnapshotInput): Promise<AssessmentSnapshot> {
    const { snapshot } = input;
    const rows = await this.db.query<MailboxAssessmentRow>(
      `INSERT INTO mailbox_assessments (
         tenant_id, mailbox_id,
         connection_health, authentication_health, sending_health, receiving_health, domain_health, configuration_health,
         risk_level, risk_score, risk_factors,
         eligibility_decision, eligibility_reasons,
         recommended_daily_volume, minimum_daily_volume, maximum_daily_volume, capacity_confidence, capacity_reasons,
         domain_assessment, assessed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        snapshot.health.connection,
        snapshot.health.authentication,
        snapshot.health.sending,
        snapshot.health.receiving,
        snapshot.health.domain,
        snapshot.health.configuration,
        snapshot.risk.riskLevel,
        snapshot.risk.riskScore,
        JSON.stringify(snapshot.risk.riskFactors),
        snapshot.eligibility.decision,
        JSON.stringify(snapshot.eligibility.reasons),
        snapshot.capacity.recommendedDailyVolume,
        snapshot.capacity.minimumDailyVolume,
        snapshot.capacity.maximumDailyVolume,
        snapshot.capacity.confidence,
        JSON.stringify(snapshot.capacity.reasons),
        snapshot.domainAssessment ? JSON.stringify(snapshot.domainAssessment) : null,
        snapshot.assessedAt,
      ],
    );
    return mapRow(expectOne(rows, "mailbox_assessments insert"));
  }

  async findLatest(tenantId: TenantId, mailboxId: MailboxId): Promise<AssessmentSnapshot | undefined> {
    const rows = await this.db.query<MailboxAssessmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailbox_assessments
       WHERE tenant_id = $1 AND mailbox_id = $2
       ORDER BY assessed_at DESC
       LIMIT 1`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listHistory(tenantId: TenantId, mailboxId: MailboxId, limit: number): Promise<AssessmentSnapshot[]> {
    const rows = await this.db.query<MailboxAssessmentRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailbox_assessments
       WHERE tenant_id = $1 AND mailbox_id = $2
       ORDER BY assessed_at DESC
       LIMIT $3`,
      [tenantId, mailboxId, limit],
    );
    return rows.map(mapRow);
  }
}

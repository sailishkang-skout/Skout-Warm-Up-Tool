import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import {
  asHealthSnapshotId,
  asMailboxId,
  asTenantId,
  asWarmupDecisionId,
  asWarmupSessionId,
  type TenantId,
  type WarmupDecisionId,
  type WarmupSessionId,
} from "../../../shared/types/index.js";
import type { CreateWarmupDecisionInput, WarmupDecisionRepository } from "../application/warmup-decision-repository.js";
import type { EligibilityDecision } from "../../policy/domain/warmup-eligibility.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";
import type { WarmupDecision, WarmupDecisionOutcome, WarmupDecisionProfileSnapshot, WarmupDecisionReasonCode } from "../domain/warmup-decision.js";

interface WarmupDecisionRow {
  id: string;
  tenant_id: string;
  session_id: string;
  mailbox_id: string;
  warmup_day: number;
  decision: WarmupDecisionOutcome;
  reason_codes: WarmupDecisionReasonCode[];
  reasons: string[];
  recommended_volume: number;
  maximum_volume: number;
  risk_level: RiskLevel;
  eligibility: EligibilityDecision;
  assessment_id: string | null;
  profile_snapshot: WarmupDecisionProfileSnapshot;
  generated_at: Date;
  created_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, session_id, mailbox_id, warmup_day, decision, reason_codes, reasons,
  recommended_volume, maximum_volume, risk_level, eligibility, assessment_id,
  profile_snapshot, generated_at, created_at
`;

function mapRow(row: WarmupDecisionRow): WarmupDecision {
  return {
    id: asWarmupDecisionId(row.id),
    tenantId: asTenantId(row.tenant_id),
    sessionId: asWarmupSessionId(row.session_id),
    mailboxId: asMailboxId(row.mailbox_id),
    warmupDay: row.warmup_day,
    decision: row.decision,
    reasonCodes: row.reason_codes,
    reasons: row.reasons,
    recommendedVolume: row.recommended_volume,
    maximumVolume: row.maximum_volume,
    riskLevel: row.risk_level,
    eligibility: row.eligibility,
    ...(row.assessment_id ? { assessmentId: asHealthSnapshotId(row.assessment_id) } : {}),
    profileSnapshot: row.profile_snapshot,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  };
}

export class PostgresWarmupDecisionRepository implements WarmupDecisionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateWarmupDecisionInput): Promise<WarmupDecision> {
    const rows = await this.db.query<WarmupDecisionRow>(
      `INSERT INTO warmup_decisions (
         tenant_id, session_id, mailbox_id, warmup_day, decision, reason_codes, reasons,
         recommended_volume, maximum_volume, risk_level, eligibility, assessment_id,
         profile_snapshot, generated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.sessionId,
        input.mailboxId,
        input.warmupDay,
        input.decision,
        JSON.stringify(input.reasonCodes),
        JSON.stringify(input.reasons),
        input.recommendedVolume,
        input.maximumVolume,
        input.riskLevel,
        input.eligibility,
        input.assessmentId ?? null,
        JSON.stringify(input.profileSnapshot),
        input.generatedAt,
      ],
    );
    return mapRow(expectOne(rows, "warmup_decisions insert"));
  }

  async findById(tenantId: TenantId, decisionId: WarmupDecisionId): Promise<WarmupDecision | undefined> {
    const rows = await this.db.query<WarmupDecisionRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_decisions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, decisionId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listBySession(tenantId: TenantId, sessionId: WarmupSessionId, limit: number): Promise<WarmupDecision[]> {
    const rows = await this.db.query<WarmupDecisionRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_decisions
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [tenantId, sessionId, limit],
    );
    return rows.map(mapRow);
  }
}

import type { HealthSnapshotId, MailboxId, TenantId, WarmupDecisionId, WarmupSessionId } from "../../../shared/types/index.js";
import type { WarmupDecision, WarmupDecisionOutcome, WarmupDecisionProfileSnapshot, WarmupDecisionReasonCode } from "../domain/warmup-decision.js";
import type { EligibilityDecision } from "../../policy/domain/warmup-eligibility.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";

export interface CreateWarmupDecisionInput {
  readonly tenantId: TenantId;
  readonly sessionId: WarmupSessionId;
  readonly mailboxId: MailboxId;
  readonly warmupDay: number;
  readonly decision: WarmupDecisionOutcome;
  readonly reasonCodes: readonly WarmupDecisionReasonCode[];
  readonly reasons: readonly string[];
  readonly recommendedVolume: number;
  readonly maximumVolume: number;
  readonly riskLevel: RiskLevel;
  readonly eligibility: EligibilityDecision;
  readonly assessmentId?: HealthSnapshotId;
  readonly profileSnapshot: WarmupDecisionProfileSnapshot;
  readonly generatedAt: Date;
}

/** Port implemented by `infrastructure/postgres-warmup-decision-repository.ts`. Append-only — see migrations/014_create_warmup_decisions.sql. */
export interface WarmupDecisionRepository {
  create(input: CreateWarmupDecisionInput): Promise<WarmupDecision>;
  findById(tenantId: TenantId, decisionId: WarmupDecisionId): Promise<WarmupDecision | undefined>;
  /** Newest first, always bounded — never an unbounded query (same rule as Stage 7's assessment history). */
  listBySession(tenantId: TenantId, sessionId: WarmupSessionId, limit: number): Promise<WarmupDecision[]>;
}

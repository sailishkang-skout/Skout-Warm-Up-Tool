import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import { asMailboxId, asTenantId, asWarmupProfileId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { CreateWarmupProfileInput, UpdateWarmupProfileInput, WarmupProfileRepository } from "../application/warmup-profile-repository.js";
import type { RampStrategy, RiskTolerance, WarmupProfile } from "../domain/warmup-profile.js";

interface WarmupProfileRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  target_daily_volume: number;
  starting_daily_volume: number;
  maximum_daily_volume: number;
  ramp_strategy: RampStrategy;
  risk_tolerance: RiskTolerance;
  active: boolean;
  pause_conditions: string[];
  window_start_minute: number | null;
  window_end_minute: number | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS =
  "id, tenant_id, mailbox_id, target_daily_volume, starting_daily_volume, maximum_daily_volume, ramp_strategy, risk_tolerance, active, pause_conditions, window_start_minute, window_end_minute, created_at, updated_at";

function mapRow(row: WarmupProfileRow): WarmupProfile {
  return {
    id: asWarmupProfileId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    targetDailyVolume: row.target_daily_volume,
    startingDailyVolume: row.starting_daily_volume,
    maximumDailyVolume: row.maximum_daily_volume,
    rampStrategy: row.ramp_strategy,
    riskTolerance: row.risk_tolerance,
    active: row.active,
    pauseConditions: row.pause_conditions,
    ...(row.window_start_minute !== null && row.window_end_minute !== null
      ? { windowStartMinute: row.window_start_minute, windowEndMinute: row.window_end_minute }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresWarmupProfileRepository implements WarmupProfileRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateWarmupProfileInput): Promise<WarmupProfile> {
    const rows = await this.db.query<WarmupProfileRow>(
      `INSERT INTO warmup_profiles
         (tenant_id, mailbox_id, target_daily_volume, starting_daily_volume, maximum_daily_volume, ramp_strategy, risk_tolerance, pause_conditions, window_start_minute, window_end_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.targetDailyVolume,
        input.startingDailyVolume,
        input.maximumDailyVolume,
        input.rampStrategy,
        input.riskTolerance,
        JSON.stringify(input.pauseConditions ?? []),
        input.windowStartMinute ?? null,
        input.windowEndMinute ?? null,
      ],
    );
    return mapRow(expectOne(rows, "warmup_profiles insert"));
  }

  async findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupProfile | undefined> {
    const rows = await this.db.query<WarmupProfileRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_profiles WHERE tenant_id = $1 AND mailbox_id = $2`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async update(tenantId: TenantId, mailboxId: MailboxId, input: UpdateWarmupProfileInput): Promise<WarmupProfile> {
    const rows = await this.db.query<WarmupProfileRow>(
      `UPDATE warmup_profiles
       SET target_daily_volume = COALESCE($3, target_daily_volume),
           starting_daily_volume = COALESCE($4, starting_daily_volume),
           maximum_daily_volume = COALESCE($5, maximum_daily_volume),
           ramp_strategy = COALESCE($6, ramp_strategy),
           risk_tolerance = COALESCE($7, risk_tolerance),
           pause_conditions = COALESCE($8::jsonb, pause_conditions),
           window_start_minute = COALESCE($9, window_start_minute),
           window_end_minute = COALESCE($10, window_end_minute)
       WHERE tenant_id = $1 AND mailbox_id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [
        tenantId,
        mailboxId,
        input.targetDailyVolume ?? null,
        input.startingDailyVolume ?? null,
        input.maximumDailyVolume ?? null,
        input.rampStrategy ?? null,
        input.riskTolerance ?? null,
        input.pauseConditions ? JSON.stringify(input.pauseConditions) : null,
        input.windowStartMinute ?? null,
        input.windowEndMinute ?? null,
      ],
    );
    if (!rows[0]) {
      throw new NotFoundError("Warmup profile for mailbox", mailboxId);
    }
    return mapRow(rows[0]);
  }

  async setActive(tenantId: TenantId, mailboxId: MailboxId, active: boolean): Promise<WarmupProfile> {
    const rows = await this.db.query<WarmupProfileRow>(
      `UPDATE warmup_profiles SET active = $3 WHERE tenant_id = $1 AND mailbox_id = $2 RETURNING ${SELECT_COLUMNS}`,
      [tenantId, mailboxId, active],
    );
    if (!rows[0]) {
      throw new NotFoundError("Warmup profile for mailbox", mailboxId);
    }
    return mapRow(rows[0]);
  }
}

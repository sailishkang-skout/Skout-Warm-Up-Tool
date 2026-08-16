import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { asMailboxId, asTenantId, asWarmupProfileId, asWarmupSessionId, type MailboxId, type TenantId, type WarmupSessionId } from "../../../shared/types/index.js";
import type { CreateWarmupSessionInput, WarmupSessionRepository } from "../application/warmup-session-repository.js";
import type { WarmupSession } from "../domain/warmup-session.js";
import type { WarmupState } from "../domain/warmup-state.js";

interface WarmupSessionRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  profile_id: string;
  state: WarmupState;
  started_at: Date | null;
  paused_at: Date | null;
  completed_at: Date | null;
  stopped_at: Date | null;
  current_day: number;
  current_daily_target: number;
  committed_volume_today: number;
  next_execution_slot: number;
  last_decision_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, profile_id, state,
  started_at, paused_at, completed_at, stopped_at,
  current_day, current_daily_target, committed_volume_today, next_execution_slot,
  last_decision_at, created_at, updated_at
`;

function mapRow(row: WarmupSessionRow): WarmupSession {
  return {
    id: asWarmupSessionId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    profileId: asWarmupProfileId(row.profile_id),
    state: row.state,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.paused_at ? { pausedAt: row.paused_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
    currentDay: row.current_day,
    currentDailyTarget: row.current_daily_target,
    committedVolumeToday: row.committed_volume_today,
    nextExecutionSlot: row.next_execution_slot,
    ...(row.last_decision_at ? { lastDecisionAt: row.last_decision_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresWarmupSessionRepository implements WarmupSessionRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateWarmupSessionInput): Promise<WarmupSession> {
    const rows = await this.db.query<WarmupSessionRow>(
      `INSERT INTO warmup_sessions (tenant_id, mailbox_id, profile_id, state)
       VALUES ($1, $2, $3, 'DRAFT')
       RETURNING ${SELECT_COLUMNS}`,
      [input.tenantId, input.mailboxId, input.profileId],
    );
    return mapRow(expectOne(rows, "warmup_sessions insert"));
  }

  async findById(tenantId: TenantId, sessionId: WarmupSessionId): Promise<WarmupSession | undefined> {
    const rows = await this.db.query<WarmupSessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_sessions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, sessionId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async findOpenByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession | undefined> {
    const rows = await this.db.query<WarmupSessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_sessions
       WHERE tenant_id = $1 AND mailbox_id = $2 AND state NOT IN ('COMPLETED', 'STOPPED')`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async findLatestByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession | undefined> {
    const rows = await this.db.query<WarmupSessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_sessions
       WHERE tenant_id = $1 AND mailbox_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async transitionState(
    tenantId: TenantId,
    sessionId: WarmupSessionId,
    fromState: WarmupState,
    toState: WarmupState,
  ): Promise<WarmupSession> {
    const rows = await this.db.query<WarmupSessionRow>(
      `UPDATE warmup_sessions
       SET state = $4,
           started_at = CASE WHEN $4 = 'ACTIVE' AND started_at IS NULL THEN now() ELSE started_at END,
           paused_at = CASE WHEN $4 = 'PAUSED' THEN now() ELSE paused_at END,
           completed_at = CASE WHEN $4 = 'COMPLETED' THEN now() ELSE completed_at END,
           stopped_at = CASE WHEN $4 = 'STOPPED' THEN now() ELSE stopped_at END
       WHERE tenant_id = $1 AND id = $2 AND state = $3
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, sessionId, fromState, toState],
    );
    if (rows[0]) {
      return mapRow(rows[0]);
    }

    const current = await this.findById(tenantId, sessionId);
    if (!current) {
      throw new NotFoundError("Warmup session", sessionId);
    }
    throw new ConflictError(
      `Warmup session is no longer in state '${fromState}' (currently '${current.state}') — it was likely changed concurrently`,
    );
  }

  async recordDailyDecision(tenantId: TenantId, sessionId: WarmupSessionId, day: number, dailyTarget: number): Promise<WarmupSession> {
    const rows = await this.db.query<WarmupSessionRow>(
      `UPDATE warmup_sessions
       SET current_daily_target = $4,
           committed_volume_today = CASE WHEN current_day = $3 THEN committed_volume_today ELSE 0 END,
           next_execution_slot = CASE WHEN current_day = $3 THEN next_execution_slot ELSE 0 END,
           current_day = $3,
           last_decision_at = now()
       WHERE tenant_id = $1 AND id = $2 AND current_day <= $3
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, sessionId, day, dailyTarget],
    );
    if (rows[0]) {
      return mapRow(rows[0]);
    }
    const current = await this.findById(tenantId, sessionId);
    if (!current) {
      throw new NotFoundError("Warmup session", sessionId);
    }
    throw new ConflictError(`Warmup session's current day (${current.currentDay}) has already advanced past ${day}`);
  }

  async commitExecutionVolume(
    tenantId: TenantId,
    sessionId: WarmupSessionId,
    day: number,
    volume: number,
  ): Promise<{ readonly session: WarmupSession; readonly allocatedSlot: number } | undefined> {
    const rows = await this.db.query<WarmupSessionRow & { allocated_slot: number }>(
      `UPDATE warmup_sessions
       SET committed_volume_today = committed_volume_today + $4,
           next_execution_slot = next_execution_slot + 1
       WHERE tenant_id = $1 AND id = $2 AND current_day = $3
         AND committed_volume_today + $4 <= current_daily_target
       RETURNING ${SELECT_COLUMNS}, next_execution_slot - 1 AS allocated_slot`,
      [tenantId, sessionId, day, volume],
    );
    if (!rows[0]) {
      return undefined;
    }
    return { session: mapRow(rows[0]), allocatedSlot: rows[0].allocated_slot };
  }
}

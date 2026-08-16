import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { ConflictError } from "../../../shared/errors/index.js";
import {
  asMailboxId,
  asTenantId,
  asWarmupDecisionId,
  asWarmupExecutionIntentId,
  asWarmupSessionId,
  type TenantId,
  type WarmupExecutionIntentId,
} from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type {
  CreateExecutionIntentInput,
  RecordExecutionResultInput,
  WarmupExecutionIntentRepository,
} from "../application/warmup-execution-intent-repository.js";
import type { ExecutionIntentStatus, WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import type { ProviderSendResult } from "../domain/send-result.js";

interface WarmupExecutionIntentRow {
  id: string;
  tenant_id: string;
  session_id: string;
  mailbox_id: string;
  decision_id: string;
  provider: MailboxProviderType;
  warmup_day: number;
  execution_slot: number;
  idempotency_key: string;
  volume: number;
  scheduled_for: Date | null;
  status: ExecutionIntentStatus;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  attempt_count: number;
  last_result: (Omit<ProviderSendResult, "timestamp"> & { timestamp: string }) | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, session_id, mailbox_id, decision_id, provider, warmup_day, execution_slot,
  idempotency_key, volume, scheduled_for, status, lease_owner, lease_expires_at, attempt_count,
  last_result, expires_at, created_at, updated_at
`;

function mapRow(row: WarmupExecutionIntentRow): WarmupExecutionIntent {
  return {
    id: asWarmupExecutionIntentId(row.id),
    tenantId: asTenantId(row.tenant_id),
    sessionId: asWarmupSessionId(row.session_id),
    mailboxId: asMailboxId(row.mailbox_id),
    decisionId: asWarmupDecisionId(row.decision_id),
    provider: row.provider,
    warmupDay: row.warmup_day,
    executionSlot: row.execution_slot,
    idempotencyKey: row.idempotency_key,
    volume: row.volume,
    ...(row.scheduled_for ? { scheduledFor: row.scheduled_for } : {}),
    status: row.status,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    attemptCount: row.attempt_count,
    ...(row.last_result ? { lastResult: { ...row.last_result, timestamp: new Date(row.last_result.timestamp) } } : {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresWarmupExecutionIntentRepository implements WarmupExecutionIntentRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createIfAbsent(input: CreateExecutionIntentInput): Promise<WarmupExecutionIntent> {
    const inserted = await this.db.query<WarmupExecutionIntentRow>(
      `INSERT INTO warmup_execution_intents (
         tenant_id, session_id, mailbox_id, decision_id, provider, warmup_day, execution_slot,
         idempotency_key, volume, scheduled_for, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.sessionId,
        input.mailboxId,
        input.decisionId,
        input.provider,
        input.warmupDay,
        input.executionSlot,
        input.idempotencyKey,
        input.volume,
        input.scheduledFor ?? null,
        input.expiresAt,
      ],
    );
    if (inserted[0]) {
      return mapRow(inserted[0]);
    }

    // Lost the insert race — Stage 8 spec section 12: a duplicate request
    // must not create a duplicate row, so return the winner's row instead.
    const existing = await this.db.query<WarmupExecutionIntentRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_execution_intents WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return mapRow(expectOne(existing, "warmup_execution_intents idempotency lookup"));
  }

  async findById(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<WarmupExecutionIntent | undefined> {
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_execution_intents WHERE tenant_id = $1 AND id = $2`,
      [tenantId, intentId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async claimNext(leaseOwner: string, leaseDurationMs: number): Promise<WarmupExecutionIntent | undefined> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `UPDATE warmup_execution_intents
       SET status = 'CLAIMED', lease_owner = $1, lease_expires_at = $2, attempt_count = attempt_count + 1
       WHERE id = (
         SELECT id FROM warmup_execution_intents
         WHERE status = 'PENDING'
           AND (scheduled_for IS NULL OR scheduled_for <= now())
           AND expires_at > now()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${SELECT_COLUMNS}`,
      [leaseOwner, leaseExpiresAt],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async markSending(tenantId: TenantId, intentId: WarmupExecutionIntentId, leaseOwner: string): Promise<WarmupExecutionIntent> {
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `UPDATE warmup_execution_intents
       SET status = 'SENDING'
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'CLAIMED'
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, intentId, leaseOwner],
    );
    if (!rows[0]) {
      throw new ConflictError("Execution intent lease is no longer held — it may have expired or been reassigned");
    }
    return mapRow(rows[0]);
  }

  async recordResult(
    tenantId: TenantId,
    intentId: WarmupExecutionIntentId,
    leaseOwner: string,
    input: RecordExecutionResultInput,
  ): Promise<WarmupExecutionIntent> {
    const releasesLease = input.status !== "PENDING";
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `UPDATE warmup_execution_intents
       SET status = $4,
           last_result = $5,
           scheduled_for = $6,
           lease_owner = CASE WHEN $7 THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN $7 THEN NULL ELSE lease_expires_at END
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND status IN ('CLAIMED', 'SENDING')
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, intentId, leaseOwner, input.status, JSON.stringify(input.result), input.scheduledFor ?? null, releasesLease],
    );
    if (!rows[0]) {
      throw new ConflictError("Execution intent lease is no longer held — it may have expired or been reassigned");
    }
    return mapRow(rows[0]);
  }
}

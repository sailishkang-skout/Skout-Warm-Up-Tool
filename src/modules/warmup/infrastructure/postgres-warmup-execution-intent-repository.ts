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
  ReclaimedIntent,
  RecordExecutionResultInput,
  WarmupExecutionIntentRepository,
} from "../application/warmup-execution-intent-repository.js";
import { MAX_ATTEMPTS } from "../domain/retry-policy.js";
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

  async renewLease(tenantId: TenantId, intentId: WarmupExecutionIntentId, leaseOwner: string, leaseDurationMs: number): Promise<boolean> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const rows = await this.db.query<{ id: string }>(
      `UPDATE warmup_execution_intents
       SET lease_expires_at = $4
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND status IN ('CLAIMED', 'SENDING')
       RETURNING id`,
      [tenantId, intentId, leaseOwner, leaseExpiresAt],
    );
    return rows.length > 0;
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<readonly ReclaimedIntent[]> {
    const rows = await this.db.query<{
      id: string;
      tenant_id: string;
      mailbox_id: string;
      session_id: string;
      attempt_count: number;
      new_status: "PENDING" | "FAILED";
    }>(
      `UPDATE warmup_execution_intents
       SET status = new_status,
           lease_owner = NULL,
           lease_expires_at = NULL
       FROM (
         SELECT id, CASE WHEN attempt_count >= $2 THEN 'FAILED' ELSE 'PENDING' END AS new_status
         FROM warmup_execution_intents
         WHERE status IN ('CLAIMED', 'SENDING') AND lease_expires_at < $1
         ORDER BY lease_expires_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       ) AS reclaimable
       WHERE warmup_execution_intents.id = reclaimable.id
       RETURNING warmup_execution_intents.id, warmup_execution_intents.tenant_id, warmup_execution_intents.mailbox_id,
                 warmup_execution_intents.session_id, warmup_execution_intents.attempt_count, reclaimable.new_status`,
      [now, MAX_ATTEMPTS, limit],
    );
    return rows.map((row) => ({
      id: asWarmupExecutionIntentId(row.id),
      tenantId: asTenantId(row.tenant_id),
      mailboxId: asMailboxId(row.mailbox_id),
      sessionId: asWarmupSessionId(row.session_id),
      attemptCount: row.attempt_count,
      newStatus: row.new_status,
    }));
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

  async deferExecution(tenantId: TenantId, intentId: WarmupExecutionIntentId, leaseOwner: string, scheduledFor: Date): Promise<WarmupExecutionIntent> {
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `UPDATE warmup_execution_intents
       SET status = 'PENDING', scheduled_for = $4, lease_owner = NULL, lease_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND lease_owner = $3 AND status IN ('CLAIMED', 'SENDING')
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, intentId, leaseOwner, scheduledFor],
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

  async markRequiresReconciliation(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<WarmupExecutionIntent> {
    // Idempotent transition: only actually moves SEND_UNKNOWN rows, but a
    // second call on an already-REQUIRES_RECONCILIATION row is not an
    // error — it just re-reads the current (unchanged) row below instead
    // of updating anything a second time.
    const rows = await this.db.query<WarmupExecutionIntentRow>(
      `UPDATE warmup_execution_intents
       SET status = 'REQUIRES_RECONCILIATION'
       WHERE tenant_id = $1 AND id = $2 AND status = 'SEND_UNKNOWN'
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, intentId],
    );
    if (rows[0]) {
      return mapRow(rows[0]);
    }

    const existing = await this.db.query<WarmupExecutionIntentRow>(
      `SELECT ${SELECT_COLUMNS} FROM warmup_execution_intents WHERE tenant_id = $1 AND id = $2`,
      [tenantId, intentId],
    );
    const current = existing[0];
    if (!current) {
      throw new ConflictError("Execution intent does not exist");
    }
    if (current.status !== "REQUIRES_RECONCILIATION") {
      throw new ConflictError(
        `Execution intent is not eligible for reconciliation (status is ${current.status}, expected SEND_UNKNOWN or REQUIRES_RECONCILIATION)`,
      );
    }
    return mapRow(current);
  }
}

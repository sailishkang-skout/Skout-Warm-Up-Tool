import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import {
  asConnectionAttemptId,
  asMailboxId,
  asTenantId,
  type ConnectionAttemptId,
  type MailboxId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type {
  ConnectionAttemptRepository,
  CreateConnectionAttemptInput,
  UpdateConnectionAttemptStatusInput,
} from "../application/connection-attempt-repository.js";
import type { ConnectionAttempt, ConnectionAttemptStatus } from "../domain/connection-attempt.js";

interface ConnectionAttemptRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  provider: MailboxProviderType;
  status: ConnectionAttemptStatus;
  started_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
  correlation_id: string | null;
}

const SELECT_COLUMNS =
  "id, tenant_id, mailbox_id, provider, status, started_at, completed_at, failure_reason, correlation_id";

function mapRow(row: ConnectionAttemptRow): ConnectionAttempt {
  return {
    id: asConnectionAttemptId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    provider: row.provider,
    status: row.status,
    startedAt: row.started_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
  };
}

export class PostgresConnectionAttemptRepository implements ConnectionAttemptRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateConnectionAttemptInput): Promise<ConnectionAttempt> {
    const rows = await this.db.query<ConnectionAttemptRow>(
      `INSERT INTO connection_attempts (tenant_id, mailbox_id, provider, correlation_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SELECT_COLUMNS}`,
      [input.tenantId, input.mailboxId, input.provider, input.correlationId ?? null],
    );
    return mapRow(expectOne(rows, "connection_attempts insert"));
  }

  async updateStatus(
    id: ConnectionAttemptId,
    input: UpdateConnectionAttemptStatusInput,
  ): Promise<ConnectionAttempt | undefined> {
    const rows = await this.db.query<ConnectionAttemptRow>(
      `UPDATE connection_attempts
       SET status = $2,
           failure_reason = $3,
           completed_at = CASE WHEN $4 THEN now() ELSE completed_at END
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, input.status, input.failureReason ?? null, input.completed ?? false],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async findActiveByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionAttempt | undefined> {
    const rows = await this.db.query<ConnectionAttemptRow>(
      `SELECT ${SELECT_COLUMNS} FROM connection_attempts
       WHERE tenant_id = $1 AND mailbox_id = $2 AND status IN ('STARTED', 'AUTHORIZED', 'VALIDATING')
       ORDER BY started_at DESC
       LIMIT 1`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

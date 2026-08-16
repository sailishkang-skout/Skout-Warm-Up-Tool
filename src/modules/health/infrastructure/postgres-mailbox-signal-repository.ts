import type { DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxSignalRepository } from "../application/mailbox-signal-repository.js";
import type { ConfidenceLevel, Signal, SignalType } from "../domain/signal.js";

interface MailboxSignalRow {
  tenant_id: string;
  mailbox_id: string;
  signal_type: SignalType;
  value: unknown;
  source: string;
  confidence: ConfidenceLevel;
  observed_at: Date;
  metadata: Record<string, unknown>;
}

const SELECT_COLUMNS = "tenant_id, mailbox_id, signal_type, value, source, confidence, observed_at, metadata";

function mapRow(row: MailboxSignalRow): Signal {
  return {
    type: row.signal_type,
    value: row.value,
    evidence: {
      source: row.source,
      observedAt: row.observed_at,
      confidence: row.confidence,
      ...(Object.keys(row.metadata).length > 0 ? { metadata: row.metadata } : {}),
    },
  };
}

export class PostgresMailboxSignalRepository implements MailboxSignalRepository {
  constructor(private readonly db: DatabaseClient) {}

  async record(tenantId: TenantId, mailboxId: MailboxId, signals: readonly Signal[]): Promise<void> {
    for (const signal of signals) {
      await this.db.query(
        `INSERT INTO mailbox_signals (tenant_id, mailbox_id, signal_type, value, source, confidence, observed_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenantId,
          mailboxId,
          signal.type,
          JSON.stringify(signal.value),
          signal.evidence.source,
          signal.evidence.confidence,
          signal.evidence.observedAt,
          JSON.stringify(signal.evidence.metadata ?? {}),
        ],
      );
    }
  }

  async listByMailbox(tenantId: TenantId, mailboxId: MailboxId, limit = 100): Promise<Signal[]> {
    const rows = await this.db.query<MailboxSignalRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailbox_signals
       WHERE tenant_id = $1 AND mailbox_id = $2
       ORDER BY observed_at DESC
       LIMIT $3`,
      [tenantId, mailboxId, limit],
    );
    return rows.map(mapRow);
  }
}

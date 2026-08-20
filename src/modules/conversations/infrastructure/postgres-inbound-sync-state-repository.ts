import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import {
  asMailboxId,
  asMailboxInboundSyncStateId,
  asTenantId,
  type MailboxId,
  type MailboxInboundSyncStateId,
  type TenantId,
} from "../../../shared/types/index.js";
import type {
  InboundSyncStateRepository,
  MailboxInboundSyncState,
  ReclaimedInboundLease,
} from "../application/inbound-sync-state-repository.js";

interface SyncRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  provider: "GMAIL" | "MICROSOFT365";
  cursor: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_success_at: Date | null;
  last_error_safe: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, provider, cursor, lease_owner, lease_expires_at,
  last_success_at, last_error_safe, created_at, updated_at
`;

function mapRow(row: SyncRow): MailboxInboundSyncState {
  return {
    id: asMailboxInboundSyncStateId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    provider: row.provider,
    ...(row.cursor ? { cursor: row.cursor } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_error_safe ? { lastErrorSafe: row.last_error_safe } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresInboundSyncStateRepository implements InboundSyncStateRepository {
  constructor(private readonly db: Database) {}

  async ensure(tenantId: TenantId, mailboxId: MailboxId, provider: "GMAIL" | "MICROSOFT365"): Promise<MailboxInboundSyncState> {
    const inserted = await this.db.query<SyncRow>(
      `INSERT INTO mailbox_inbound_sync_state (tenant_id, mailbox_id, provider)
       VALUES ($1, $2, $3)
       ON CONFLICT (mailbox_id) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, mailboxId, provider],
    );
    if (inserted[0]) {
      return mapRow(inserted[0]);
    }
    const existing = await this.db.query<SyncRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailbox_inbound_sync_state WHERE mailbox_id = $1 AND tenant_id = $2`,
      [mailboxId, tenantId],
    );
    return mapRow(existing[0]!);
  }

  async claimNext(leaseOwner: string, leaseDurationMs: number): Promise<MailboxInboundSyncState | undefined> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const rows = await this.db.query<SyncRow>(
      `UPDATE mailbox_inbound_sync_state
       SET lease_owner = $1, lease_expires_at = $2
       WHERE id = (
         SELECT s.id FROM mailbox_inbound_sync_state s
         INNER JOIN mailboxes m ON m.id = s.mailbox_id AND m.tenant_id = s.tenant_id
         WHERE m.enabled = true
           AND m.status = 'CONNECTED'
           AND s.provider IN ('GMAIL', 'MICROSOFT365')
           AND (s.lease_owner IS NULL OR s.lease_expires_at < now())
         ORDER BY s.updated_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${SELECT_COLUMNS}`,
      [leaseOwner, leaseExpiresAt],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<readonly ReclaimedInboundLease[]> {
    const rows = await this.db.query<SyncRow>(
      `UPDATE mailbox_inbound_sync_state
       SET lease_owner = NULL, lease_expires_at = NULL
       WHERE id IN (
         SELECT id FROM mailbox_inbound_sync_state
         WHERE lease_owner IS NOT NULL AND lease_expires_at < $1
         ORDER BY lease_expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${SELECT_COLUMNS}`,
      [now, limit],
    );
    return rows.map((row) => ({
      id: asMailboxInboundSyncStateId(row.id),
      tenantId: asTenantId(row.tenant_id),
      mailboxId: asMailboxId(row.mailbox_id),
    }));
  }

  async completeSuccess(
    client: DatabaseClient,
    id: MailboxInboundSyncStateId,
    leaseOwner: string,
    cursor: string | undefined,
  ): Promise<void> {
    await client.query(
      `UPDATE mailbox_inbound_sync_state
       SET cursor = $3, last_success_at = now(), last_error_safe = NULL,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, cursor ?? null],
    );
  }

  async completeFailure(id: MailboxInboundSyncStateId, leaseOwner: string, lastErrorSafe: string): Promise<void> {
    await this.db.query(
      `UPDATE mailbox_inbound_sync_state
       SET last_error_safe = $3, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, lastErrorSafe],
    );
  }

  async releaseLease(id: MailboxInboundSyncStateId, leaseOwner: string): Promise<void> {
    await this.db.query(
      `UPDATE mailbox_inbound_sync_state
       SET lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner],
    );
  }
}

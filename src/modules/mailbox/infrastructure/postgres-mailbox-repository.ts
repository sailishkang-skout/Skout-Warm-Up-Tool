import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asMailboxId, asTenantId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { CreateMailboxInput, MailboxRepository } from "../application/mailbox-repository.js";
import { canonicalizeEmailAddress } from "../domain/email-canonicalization.js";
import type { Mailbox, MailboxProviderType, MailboxStatus } from "../domain/mailbox.js";

interface MailboxRow {
  id: string;
  tenant_id: string;
  email_address: string;
  email_address_canonical: string;
  provider: MailboxProviderType;
  status: MailboxStatus;
  enabled: boolean;
  display_name: string | null;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS =
  "id, tenant_id, email_address, email_address_canonical, provider, status, enabled, display_name, timezone, created_at, updated_at";

function mapRow(row: MailboxRow): Mailbox {
  return {
    id: asMailboxId(row.id),
    tenantId: asTenantId(row.tenant_id),
    emailAddress: row.email_address,
    emailAddressCanonical: row.email_address_canonical,
    provider: row.provider,
    status: row.status,
    enabled: row.enabled,
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    timezone: row.timezone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresMailboxRepository implements MailboxRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateMailboxInput): Promise<Mailbox> {
    const canonical = canonicalizeEmailAddress(input.emailAddress);
    const rows = await this.db.query<MailboxRow>(
      `INSERT INTO mailboxes (tenant_id, email_address, email_address_canonical, provider, status, display_name, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'UTC'))
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.emailAddress,
        canonical,
        input.provider,
        input.status ?? "PENDING",
        input.displayName ?? null,
        input.timezone ?? null,
      ],
    );
    return mapRow(expectOne(rows, "mailboxes insert"));
  }

  async findById(tenantId: TenantId, id: MailboxId): Promise<Mailbox | undefined> {
    const rows = await this.db.query<MailboxRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailboxes WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listByTenant(tenantId: TenantId): Promise<Mailbox[]> {
    const rows = await this.db.query<MailboxRow>(
      `SELECT ${SELECT_COLUMNS} FROM mailboxes WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map(mapRow);
  }

  async updateStatus(tenantId: TenantId, id: MailboxId, status: MailboxStatus): Promise<Mailbox | undefined> {
    const rows = await this.db.query<MailboxRow>(
      `UPDATE mailboxes SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
      [tenantId, id, status],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async updateEnabled(tenantId: TenantId, id: MailboxId, enabled: boolean): Promise<Mailbox | undefined> {
    const rows = await this.db.query<MailboxRow>(
      `UPDATE mailboxes SET enabled = $3 WHERE tenant_id = $1 AND id = $2 RETURNING ${SELECT_COLUMNS}`,
      [tenantId, id, enabled],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

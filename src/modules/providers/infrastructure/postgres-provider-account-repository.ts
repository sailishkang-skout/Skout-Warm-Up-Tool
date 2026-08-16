import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asMailboxId, asProviderAccountId, asTenantId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type {
  CreateProviderAccountInput,
  ProviderAccountRepository,
  UpdateProviderConnectionOutcomeInput,
} from "../application/provider-account-repository.js";
import type { ProviderAccount, ProviderAccountStatus } from "../domain/provider-account.js";

interface ProviderAccountRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  provider: MailboxProviderType;
  status: ProviderAccountStatus;
  external_account_ref: string | null;
  metadata: Record<string, unknown>;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS =
  "id, tenant_id, mailbox_id, provider, status, external_account_ref, metadata, last_checked_at, last_error, created_at, updated_at";

function mapRow(row: ProviderAccountRow): ProviderAccount {
  return {
    id: asProviderAccountId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    provider: row.provider,
    status: row.status,
    ...(row.external_account_ref !== null ? { externalAccountRef: row.external_account_ref } : {}),
    metadata: row.metadata,
    ...(row.last_checked_at !== null ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresProviderAccountRepository implements ProviderAccountRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateProviderAccountInput): Promise<ProviderAccount> {
    const rows = await this.db.query<ProviderAccountRow>(
      `INSERT INTO provider_accounts (tenant_id, mailbox_id, provider, status, external_account_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.provider,
        input.status ?? "PENDING",
        input.externalAccountRef ?? null,
      ],
    );
    return mapRow(expectOne(rows, "provider_accounts insert"));
  }

  async findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderAccount | undefined> {
    const rows = await this.db.query<ProviderAccountRow>(
      `SELECT ${SELECT_COLUMNS} FROM provider_accounts WHERE tenant_id = $1 AND mailbox_id = $2`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async updateConnectionOutcome(
    tenantId: TenantId,
    mailboxId: MailboxId,
    input: UpdateProviderConnectionOutcomeInput,
  ): Promise<ProviderAccount | undefined> {
    const rows = await this.db.query<ProviderAccountRow>(
      `UPDATE provider_accounts
       SET status = $3,
           last_checked_at = $4,
           last_error = $5,
           metadata = metadata || $6::jsonb
       WHERE tenant_id = $1 AND mailbox_id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [
        tenantId,
        mailboxId,
        input.status,
        input.lastCheckedAt,
        input.lastError ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

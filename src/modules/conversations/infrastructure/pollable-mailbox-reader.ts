import type { Database } from "../../../shared/db/index.js";
import { asMailboxId, asTenantId, type MailboxId, type TenantId } from "../../../shared/types/index.js";

export interface PollableMailbox {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: "GMAIL" | "MICROSOFT365";
}

export function createPollableMailboxReader(db: Database) {
  return {
    async list(): Promise<readonly PollableMailbox[]> {
      const rows = await db.query<{ id: string; tenant_id: string; provider: "GMAIL" | "MICROSOFT365" }>(
        `SELECT id, tenant_id, provider FROM mailboxes
         WHERE enabled = true
           AND status = 'CONNECTED'
           AND provider IN ('GMAIL', 'MICROSOFT365')`,
      );
      return rows.map((row) => ({
        tenantId: asTenantId(row.tenant_id),
        mailboxId: asMailboxId(row.id),
        provider: row.provider,
      }));
    },
  };
}

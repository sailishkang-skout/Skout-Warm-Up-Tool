import type { Database } from "../../../shared/db/index.js";
import type { MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";
import { asMailboxId, asTenantId, asWarmupExecutionIntentId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderSendResult } from "../../warmup/domain/send-result.js";

/**
 * Read-only view of completed warmup sends for outbound materialization.
 * Lives in conversations so the warmup intent repository stays frozen.
 */
export interface UnmaterializedSentIntent {
  readonly id: WarmupExecutionIntentId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly lastResult?: ProviderSendResult;
}

export function createUnmaterializedSentIntentReader(db: Database) {
  return {
    async list(limit: number): Promise<readonly UnmaterializedSentIntent[]> {
      const rows = await db.query<{
        id: string;
        tenant_id: string;
        mailbox_id: string;
        provider: MailboxProviderType;
        last_result: (Omit<ProviderSendResult, "timestamp"> & { timestamp: string }) | null;
      }>(
        `SELECT i.id, i.tenant_id, i.mailbox_id, i.provider, i.last_result
         FROM warmup_execution_intents i
         WHERE i.status = 'SENT'
           AND NOT EXISTS (
             SELECT 1 FROM conversation_messages m
             WHERE m.execution_intent_id = i.id
           )
         ORDER BY i.updated_at ASC
         LIMIT $1`,
        [limit],
      );
      return rows.map((row) => ({
        id: asWarmupExecutionIntentId(row.id),
        tenantId: asTenantId(row.tenant_id),
        mailboxId: asMailboxId(row.mailbox_id),
        provider: row.provider,
        ...(row.last_result
          ? { lastResult: { ...row.last_result, timestamp: new Date(row.last_result.timestamp) } }
          : {}),
      }));
    },
  };
}

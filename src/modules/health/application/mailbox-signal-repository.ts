import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { Signal } from "../domain/signal.js";

/** Port implemented by `infrastructure/postgres-mailbox-signal-repository.ts`. Append-only — see migrations/010_create_mailbox_signals.sql. */
export interface MailboxSignalRepository {
  record(tenantId: TenantId, mailboxId: MailboxId, signals: readonly Signal[]): Promise<void>;
  listByMailbox(tenantId: TenantId, mailboxId: MailboxId, limit?: number): Promise<Signal[]>;
}

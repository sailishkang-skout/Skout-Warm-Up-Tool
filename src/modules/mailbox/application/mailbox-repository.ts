import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { Mailbox, MailboxProviderType, MailboxStatus } from "../domain/mailbox.js";

export interface CreateMailboxInput {
  readonly tenantId: TenantId;
  readonly emailAddress: string;
  readonly provider: MailboxProviderType;
  readonly displayName?: string;
  readonly status?: MailboxStatus;
}

/**
 * Port implemented by `infrastructure/postgres-mailbox-repository.ts`.
 * `tenantId` is a required parameter on every read/write — not optional,
 * not inferred — so tenant isolation is structurally impossible to forget
 * at a call site.
 */
export interface MailboxRepository {
  create(input: CreateMailboxInput): Promise<Mailbox>;
  findById(tenantId: TenantId, id: MailboxId): Promise<Mailbox | undefined>;
  listByTenant(tenantId: TenantId): Promise<Mailbox[]>;
  /** Only the domain layer (`mailbox-lifecycle.ts`) decides whether a transition is valid — this just persists it. */
  updateStatus(tenantId: TenantId, id: MailboxId, status: MailboxStatus): Promise<Mailbox | undefined>;
  updateEnabled(tenantId: TenantId, id: MailboxId, enabled: boolean): Promise<Mailbox | undefined>;
}

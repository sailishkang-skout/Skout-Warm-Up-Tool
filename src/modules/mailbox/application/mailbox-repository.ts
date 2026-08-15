import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { Mailbox, MailboxProviderType, MailboxStatus } from "../domain/mailbox.js";

export interface CreateMailboxInput {
  readonly tenantId: TenantId;
  readonly emailAddress: string;
  readonly provider: MailboxProviderType;
  readonly status?: MailboxStatus;
}

/**
 * Port implemented by `infrastructure/postgres-mailbox-repository.ts`.
 * `tenantId` is a required parameter on every read — not optional, not
 * inferred — so tenant isolation is structurally impossible to forget at a
 * call site, not just a convention repositories are expected to follow.
 */
export interface MailboxRepository {
  create(input: CreateMailboxInput): Promise<Mailbox>;
  findById(tenantId: TenantId, id: MailboxId): Promise<Mailbox | undefined>;
  listByTenant(tenantId: TenantId): Promise<Mailbox[]>;
}

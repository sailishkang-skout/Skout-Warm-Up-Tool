import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderAccount, ProviderAccountStatus } from "../domain/provider-account.js";

export interface CreateProviderAccountInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status?: ProviderAccountStatus;
  readonly externalAccountRef?: string;
}

/** Port implemented by `infrastructure/postgres-provider-account-repository.ts`. */
export interface ProviderAccountRepository {
  create(input: CreateProviderAccountInput): Promise<ProviderAccount>;
  findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderAccount | undefined>;
}

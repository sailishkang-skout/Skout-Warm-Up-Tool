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

export interface UpdateProviderConnectionOutcomeInput {
  readonly status: ProviderAccountStatus;
  readonly lastCheckedAt: Date;
  readonly lastError?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Port implemented by `infrastructure/postgres-provider-account-repository.ts`. */
export interface ProviderAccountRepository {
  create(input: CreateProviderAccountInput): Promise<ProviderAccount>;
  findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderAccount | undefined>;
  /** Records the outcome of a connection/health-check attempt — status, when, and a safe reason. */
  updateConnectionOutcome(
    tenantId: TenantId,
    mailboxId: MailboxId,
    input: UpdateProviderConnectionOutcomeInput,
  ): Promise<ProviderAccount | undefined>;
}

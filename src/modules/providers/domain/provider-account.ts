import type { MailboxId, ProviderAccountId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

export const PROVIDER_ACCOUNT_STATUSES = ["PENDING", "ACTIVE", "DISCONNECTED", "ERROR"] as const;
export type ProviderAccountStatus = (typeof PROVIDER_ACCOUNT_STATUSES)[number];

/**
 * The connection/configuration relationship between a mailbox and its
 * external provider. Deliberately holds no credentials or tokens — only
 * non-secret metadata. `externalAccountRef` is an opaque provider-supplied
 * identifier (e.g. a Google subject id), never a secret. Encrypted
 * credential storage is a later stage's concern with its own table and its
 * own access boundary, not this one.
 */
export interface ProviderAccount {
  readonly id: ProviderAccountId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status: ProviderAccountStatus;
  readonly externalAccountRef?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

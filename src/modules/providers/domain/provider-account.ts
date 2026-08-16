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
 *
 * `status` here is this provider connection's own state — deliberately a
 * separate concept from `Mailbox.status` (which tracks the mailbox's
 * connection lifecycle from the application's point of view). The two are
 * related but not identical: a mailbox can be operationally `enabled` while
 * its provider account sits at `ERROR`.
 *
 * `metadata` is for safe, non-secret, provider-supplied information only
 * (e.g. a resolved display name) — never credentials, tokens, or anything
 * that would need redaction. `lastError` is a safe, curated message, never
 * a raw provider/OAuth exception.
 */
export interface ProviderAccount {
  readonly id: ProviderAccountId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status: ProviderAccountStatus;
  readonly externalAccountRef?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lastCheckedAt?: Date;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

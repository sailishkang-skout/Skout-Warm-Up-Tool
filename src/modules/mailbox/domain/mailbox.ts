import type { MailboxId, TenantId } from "../../../shared/types/index.js";

/**
 * Named `MailboxProviderType` rather than `MailboxProvider` deliberately:
 * Stage 1 already reserved `MailboxProvider` (see
 * src/modules/providers/README.md) for the Stage 5 provider *adapter*
 * interface (`connect`/`send`/`getCapabilities`/...). This is only the
 * enum of which provider a mailbox uses — reusing the name would collide
 * with that already-committed architecture.
 *
 * Values are `GMAIL`/`MICROSOFT365`/`SMTP_IMAP` rather than the Stage 5
 * spec's suggested `GOOGLE`/`MICROSOFT_365` — kept as-is from Stage 3 since
 * they refer to the exact same provider families and renaming would mean a
 * schema-breaking migration (the `mailboxes.provider`/`provider_accounts.provider`
 * CHECK constraints) for no functional benefit.
 */
export const MAILBOX_PROVIDER_TYPES = ["GMAIL", "MICROSOFT365", "SMTP_IMAP"] as const;
export type MailboxProviderType = (typeof MAILBOX_PROVIDER_TYPES)[number];

/**
 * Connection lifecycle only — see `mailbox-lifecycle.ts` for the valid
 * transition graph. Deliberately does NOT include warmup progress
 * (WARMING/HEALTHY/OUTBOUND_READY/...) or risk states (AT_RISK/PAUSED/...):
 * those describe a different concern (how warmup is going) that belongs to
 * a future warmup_profile, not to whether the mailbox is currently
 * connected to its provider. Also deliberately does NOT include "disabled"
 * — that's the orthogonal `enabled` flag below, not a connection state (see
 * migrations/006_mailbox_lifecycle_and_provider_metadata.sql).
 */
export const MAILBOX_STATUSES = ["PENDING", "CONNECTING", "CONNECTED", "DISCONNECTED", "ERROR"] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export interface Mailbox {
  readonly id: MailboxId;
  readonly tenantId: TenantId;
  readonly emailAddress: string;
  readonly emailAddressCanonical: string;
  readonly provider: MailboxProviderType;
  readonly status: MailboxStatus;
  /** Operational on/off switch, independent of `status` — a mailbox can be enabled but DISCONNECTED, or disabled but still CONNECTED. */
  readonly enabled: boolean;
  readonly displayName?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

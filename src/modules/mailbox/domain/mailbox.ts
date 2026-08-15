import type { MailboxId, TenantId } from "../../../shared/types/index.js";

/**
 * Named `MailboxProviderType` rather than `MailboxProvider` deliberately:
 * Stage 1 already reserved `MailboxProvider` (see
 * src/modules/providers/README.md) for the Stage 5 provider *adapter*
 * interface (`connect`/`send`/`getCapabilities`/...). This is only the
 * enum of which provider a mailbox uses — reusing the name would collide
 * with that already-committed architecture.
 */
export const MAILBOX_PROVIDER_TYPES = ["GMAIL", "MICROSOFT365", "SMTP_IMAP"] as const;
export type MailboxProviderType = (typeof MAILBOX_PROVIDER_TYPES)[number];

export const MAILBOX_STATUSES = [
  // onboarding lifecycle
  "NEW",
  "CONNECTING",
  "CONNECTED",
  "VALIDATING",
  "ASSESSED",
  "WARMUP_INITIALIZED",
  "WARMING",
  "HEALTHY",
  "OUTBOUND_READY",
  "MONITORING",
  // risk states
  "AT_RISK",
  "RECOVERY",
  "PAUSED",
  "FAILED",
  "DISCONNECTED",
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export interface Mailbox {
  readonly id: MailboxId;
  readonly tenantId: TenantId;
  readonly emailAddress: string;
  readonly emailAddressCanonical: string;
  readonly provider: MailboxProviderType;
  readonly status: MailboxStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Operational mailbox lifecycle — independent of connection `Mailbox.status`
 * (PENDING/CONNECTING/CONNECTED/...) and independent of health/risk.
 * Warmup eligibility still uses connection status + enabled + assessments.
 */
export const MAILBOX_OPERATIONAL_STATUSES = [
  "DISCOVERED",
  "PROVISIONING",
  "PROVISIONED",
  "VERIFYING",
  "READY",
  "WARMING",
  "ACTIVE",
  "DEGRADED",
  "QUARANTINED",
  "SUSPENDED",
  "DELETED",
] as const;
export type MailboxOperationalStatus = (typeof MAILBOX_OPERATIONAL_STATUSES)[number];

const ALLOWED: Readonly<Record<MailboxOperationalStatus, readonly MailboxOperationalStatus[]>> = {
  DISCOVERED: ["PROVISIONING", "VERIFYING", "DELETED"],
  PROVISIONING: ["PROVISIONED", "DISCOVERED", "DELETED"],
  PROVISIONED: ["VERIFYING", "READY", "SUSPENDED", "DELETED"],
  VERIFYING: ["READY", "PROVISIONED", "DELETED"],
  READY: ["WARMING", "ACTIVE", "DEGRADED", "QUARANTINED", "SUSPENDED", "DELETED"],
  WARMING: ["ACTIVE", "READY", "DEGRADED", "QUARANTINED", "SUSPENDED"],
  ACTIVE: ["WARMING", "DEGRADED", "QUARANTINED", "SUSPENDED", "READY"],
  DEGRADED: ["READY", "ACTIVE", "QUARANTINED", "SUSPENDED"],
  QUARANTINED: ["READY", "DEGRADED", "SUSPENDED"],
  SUSPENDED: ["READY", "DELETED"],
  DELETED: [],
};

export function canTransitionOperationalStatus(
  from: MailboxOperationalStatus,
  to: MailboxOperationalStatus,
): boolean {
  return ALLOWED[from].includes(to);
}

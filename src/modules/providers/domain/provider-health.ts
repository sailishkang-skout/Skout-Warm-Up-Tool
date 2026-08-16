import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

export const PROVIDER_HEALTH_STATUSES = ["HEALTHY", "DEGRADED", "UNAVAILABLE", "UNAUTHENTICATED", "UNKNOWN"] as const;
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH_STATUSES)[number];

/**
 * `message` must always be safe to log/return — never a raw provider
 * exception message. Stage 5 adapters have nothing real to check yet, so
 * they return `UNKNOWN` with an explanatory, non-sensitive message rather
 * than fabricating `HEALTHY`.
 */
export interface ProviderHealthResult {
  readonly status: ProviderHealthStatus;
  readonly providerType: MailboxProviderType;
  readonly checkedAt: Date;
  readonly latencyMs?: number;
  readonly message?: string;
}

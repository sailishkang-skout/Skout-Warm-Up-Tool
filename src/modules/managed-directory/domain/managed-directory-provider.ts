import type { ProviderConfigurationStatus } from "../../providers/domain/provider-adapter.js";

export const MANAGED_DIRECTORY_ERROR_CODES = [
  "NETWORK_ERROR",
  "AUTH_ERROR",
  "RATE_LIMIT",
  "VALIDATION_ERROR",
  "PROVIDER_NOT_READY",
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "TEMPORARY_FAILURE",
  "PERMANENT_FAILURE",
  "NOT_CONFIGURED",
  "UNKNOWN",
] as const;
export type ManagedDirectoryErrorCode = (typeof MANAGED_DIRECTORY_ERROR_CODES)[number];

export interface ManagedDirectoryResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly errorCode?: ManagedDirectoryErrorCode;
  readonly safeReason?: string;
}

/**
 * Directory/lifecycle operations for a Google Workspace customer or
 * Microsoft 365 tenant. Deliberately separate from `ProviderAdapter`, which
 * remains the send/OAuth boundary the warmup engine uses.
 */
export interface ManagedDirectoryProvider {
  readonly provider: "GMAIL" | "MICROSOFT365";
  getConfigurationStatus(): ProviderConfigurationStatus;
  createCustomer(input: { domain: string; displayName: string }): Promise<ManagedDirectoryResult<{ providerCustomerId: string }>>;
  getCustomer(input: { providerCustomerId: string }): Promise<ManagedDirectoryResult<{ providerCustomerId: string; domain?: string }>>;
  verifyDomain(input: { providerCustomerId: string; domain: string }): Promise<ManagedDirectoryResult<{ verified: boolean }>>;
  createSubscription?(input: { providerCustomerId: string; skuId: string }): Promise<ManagedDirectoryResult<{ subscriptionId: string }>>;
  getSubscription?(input: { providerCustomerId: string; subscriptionId: string }): Promise<ManagedDirectoryResult<{ subscriptionId: string; status: string }>>;
  createMailbox(input: {
    providerCustomerId: string;
    emailAddress: string;
    displayName?: string;
  }): Promise<ManagedDirectoryResult<{ providerMailboxId: string }>>;
  getMailbox(input: {
    providerCustomerId: string;
    providerMailboxId: string;
  }): Promise<ManagedDirectoryResult<{ providerMailboxId: string; emailAddress?: string }>>;
  updateMailbox?(input: {
    providerCustomerId: string;
    providerMailboxId: string;
    displayName?: string;
  }): Promise<ManagedDirectoryResult<{ providerMailboxId: string }>>;
  suspendMailbox(input: { providerCustomerId: string; providerMailboxId: string }): Promise<ManagedDirectoryResult<{ suspended: boolean }>>;
  restoreMailbox(input: { providerCustomerId: string; providerMailboxId: string }): Promise<ManagedDirectoryResult<{ restored: boolean }>>;
  deleteMailbox(input: { providerCustomerId: string; providerMailboxId: string }): Promise<ManagedDirectoryResult<{ deleted: boolean }>>;
  getHealth(): Promise<ManagedDirectoryResult<{ status: "UNKNOWN" | "HEALTHY" | "DEGRADED" }>>;
}

export function notConfiguredResult<T>(): ManagedDirectoryResult<T> {
  return {
    ok: false,
    errorCode: "NOT_CONFIGURED",
    safeReason: "Managed directory APIs are not configured in this deployment. Connect existing mailboxes via OAuth (Mode B) or supply reseller/CSP credentials.",
  };
}

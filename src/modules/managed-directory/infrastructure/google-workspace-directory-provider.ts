import type { ManagedDirectoryProvider } from "../domain/managed-directory-provider.js";
import { notConfiguredResult } from "../domain/managed-directory-provider.js";

/**
 * Google Workspace reseller/customer/directory lifecycle. This deployment
 * does not invent reseller credentials. Until GOOGLE_WORKSPACE_RESELLER_* is
 * configured, every mutating call returns NOT_CONFIGURED rather than
 * fabricating a Workspace customer.
 */
export function createGoogleWorkspaceDirectoryProvider(configured: boolean): ManagedDirectoryProvider {
  return {
    provider: "GMAIL",
    getConfigurationStatus: () => (configured ? "CONFIGURED" : "NOT_CONFIGURED"),
    async createCustomer() {
      return notConfiguredResult();
    },
    async verifyDomain() {
      return notConfiguredResult();
    },
    async createMailbox() {
      return notConfiguredResult();
    },
    async suspendMailbox() {
      return notConfiguredResult();
    },
    async getHealth() {
      if (!configured) {
        return notConfiguredResult();
      }
      return { ok: true, value: { status: "UNKNOWN" } };
    },
  };
}

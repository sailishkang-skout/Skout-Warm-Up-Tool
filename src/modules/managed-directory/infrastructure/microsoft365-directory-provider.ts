import type { ManagedDirectoryProvider } from "../domain/managed-directory-provider.js";
import { notConfiguredResult } from "../domain/managed-directory-provider.js";

/**
 * Microsoft CSP / Graph directory lifecycle. Same honesty rule as Google:
 * no invented Partner Center credentials, no fake tenants.
 */
export function createMicrosoft365DirectoryProvider(configured: boolean): ManagedDirectoryProvider {
  return {
    provider: "MICROSOFT365",
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

import { ConfigurationError } from "../../../shared/errors/index.js";
import type { ProviderAccountId } from "../../../shared/types/index.js";
import type { ProviderCredentialStore } from "../application/provider-credential-store.js";
import type { ProviderCredential } from "../domain/provider-credential.js";

/**
 * NOT FOR PRODUCTION USE. An in-process `Map` — credentials vanish on
 * restart, are visible to anything in the same process, and are never
 * encrypted at rest (there is no "at rest": it's live process memory).
 * This exists only so Stage 5 has a working `ProviderCredentialStore`
 * implementation to develop and test the provider/mailbox boundary against
 * before a real secret store (KMS-backed, most likely) lands in a later
 * stage behind the same interface.
 *
 * Refuses to construct when `isProduction` is true — the real store doesn't
 * exist yet, so there is no safe production behavior to fall back to.
 */
export function createInMemoryProviderCredentialStore(options: { isProduction: boolean }): ProviderCredentialStore {
  if (options.isProduction) {
    throw new ConfigurationError(
      "createInMemoryProviderCredentialStore must never be used in production — no production-grade " +
        "credential store is implemented yet",
    );
  }

  const credentials = new Map<ProviderAccountId, ProviderCredential>();

  return {
    async getCredential(providerAccountId: ProviderAccountId): Promise<ProviderCredential | undefined> {
      return credentials.get(providerAccountId);
    },
    async saveCredential(credential: ProviderCredential): Promise<void> {
      credentials.set(credential.providerAccountId, credential);
    },
    async deleteCredential(providerAccountId: ProviderAccountId): Promise<void> {
      credentials.delete(providerAccountId);
    },
  };
}

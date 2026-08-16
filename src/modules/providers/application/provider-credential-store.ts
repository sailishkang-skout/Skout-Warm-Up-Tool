import type { ProviderAccountId } from "../../../shared/types/index.js";
import type { ProviderCredential } from "../domain/provider-credential.js";

/**
 * The provider layer never knows *where* a secret physically lives — only
 * this interface. `infrastructure/in-memory-provider-credential-store.ts` is
 * Stage 5's implementation, explicitly non-production (see its own doc
 * comment); real secret storage (a KMS-backed store, most likely) is a
 * later stage and swaps in behind this same interface with no change to
 * `MailboxService` or any `ProviderAdapter`.
 */
export interface ProviderCredentialStore {
  getCredential(providerAccountId: ProviderAccountId): Promise<ProviderCredential | undefined>;
  saveCredential(credential: ProviderCredential): Promise<void>;
  deleteCredential(providerAccountId: ProviderAccountId): Promise<void>;
}

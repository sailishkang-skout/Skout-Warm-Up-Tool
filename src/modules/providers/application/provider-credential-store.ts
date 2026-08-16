import type { ProviderAccountId } from "../../../shared/types/index.js";
import type { ProviderCredential } from "../domain/provider-credential.js";

/**
 * The provider layer never knows *where* a secret physically lives — only
 * this interface. `infrastructure/postgres-provider-credential-store.ts` is
 * Stage 6's production implementation (AES-256-GCM encrypted at rest — see
 * src/shared/crypto/encryption-service.ts); `in-memory-provider-credential-store.ts`
 * remains only as a fast test double, explicitly non-production.
 *
 * `saveCredential` supersedes rather than overwrites: a prior ACTIVE
 * credential for the same provider account becomes REVOKED, never deleted
 * (see migrations/007_create_provider_credentials.sql). `revokeCredential`
 * is named deliberately, not `deleteCredential` — Stage 6 requires
 * historical credential rows survive a mailbox disconnect.
 */
export interface ProviderCredentialStore {
  getCredential(providerAccountId: ProviderAccountId): Promise<ProviderCredential | undefined>;
  saveCredential(credential: ProviderCredential): Promise<void>;
  revokeCredential(providerAccountId: ProviderAccountId): Promise<void>;
}

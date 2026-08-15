import type { ApiCredentialId, TenantId } from "../../../shared/types/index.js";
import type { ApiCredential, ApiCredentialWithHash } from "../domain/api-credential.js";

export interface CreateApiCredentialInput {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly expiresAt?: Date;
}

/**
 * Port implemented by `infrastructure/postgres-api-credential-repository.ts`.
 *
 * `findByPrefix` is the one deliberate exception to "every read requires a
 * TenantId" — it's the credential-resolution step during authentication,
 * which necessarily runs *before* a tenant is known. Every other method
 * requires TenantId, matching the pattern established in Stage 3.
 */
export interface ApiCredentialRepository {
  create(input: CreateApiCredentialInput): Promise<ApiCredential>;
  findByPrefix(keyPrefix: string): Promise<ApiCredentialWithHash | undefined>;
  findById(tenantId: TenantId, id: ApiCredentialId): Promise<ApiCredential | undefined>;
  listByTenant(tenantId: TenantId): Promise<ApiCredential[]>;
  revoke(tenantId: TenantId, id: ApiCredentialId): Promise<ApiCredential | undefined>;
  touchLastUsed(id: ApiCredentialId): Promise<void>;
}

import type { ApiCredentialId, TenantId } from "../../../shared/types/index.js";

export const API_CREDENTIAL_STATUSES = ["ACTIVE", "REVOKED", "EXPIRED"] as const;
export type ApiCredentialStatus = (typeof API_CREDENTIAL_STATUSES)[number];

/**
 * Never carries the secret, the full API key, or the hash — only what's
 * safe to hold anywhere above the repository layer and safe to return from
 * a list/create/rotate/revoke API response.
 */
export interface ApiCredential {
  readonly id: ApiCredentialId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly keyPrefix: string;
  readonly status: ApiCredentialStatus;
  readonly expiresAt?: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Only ever returned by `ApiCredentialRepository.findByPrefix` — the one
 * place `keyHash` needs to exist in memory, for the single comparison in
 * `authentication-service.ts`. Deliberately a distinct type rather than an
 * optional field on `ApiCredential`, so a list/create/rotate/revoke
 * response can never accidentally include it — there's no field to forget
 * to omit.
 */
export interface ApiCredentialWithHash extends ApiCredential {
  readonly keyHash: string;
}

import { randomUUID } from "node:crypto";
import type {
  ApiCredentialRepository,
  CreateApiCredentialInput,
} from "../../src/modules/auth/application/api-credential-repository.js";
import type { ApiCredentialWithHash } from "../../src/modules/auth/domain/api-credential.js";
import { asApiCredentialId, type ApiCredentialId, type TenantId } from "../../src/shared/types/index.js";

export interface FakeApiCredentialRepository extends ApiCredentialRepository {
  seed(credential: Partial<ApiCredentialWithHash> & { tenantId: TenantId; keyPrefix: string; keyHash: string }): ApiCredentialWithHash;
  touchedLastUsedIds: ApiCredentialId[];
}

/** In-memory `ApiCredentialRepository` for unit tests that must not touch a real database. */
export function createFakeApiCredentialRepository(): FakeApiCredentialRepository {
  const credentials = new Map<ApiCredentialId, ApiCredentialWithHash>();
  const touchedLastUsedIds: ApiCredentialId[] = [];

  function seed(
    input: Partial<ApiCredentialWithHash> & { tenantId: TenantId; keyPrefix: string; keyHash: string },
  ): ApiCredentialWithHash {
    const credential: ApiCredentialWithHash = {
      id: input.id ?? asApiCredentialId(randomUUID()),
      tenantId: input.tenantId,
      name: input.name ?? "Test credential",
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      status: input.status ?? "ACTIVE",
      createdAt: input.createdAt ?? new Date(),
      updatedAt: input.updatedAt ?? new Date(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
      ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
    };
    credentials.set(credential.id, credential);
    return credential;
  }

  function stripHash(credential: ApiCredentialWithHash) {
    const { keyHash: _keyHash, ...safe } = credential;
    return safe;
  }

  return {
    seed,
    touchedLastUsedIds,
    async create(input: CreateApiCredentialInput) {
      return stripHash(
        seed({
          tenantId: input.tenantId,
          name: input.name,
          keyPrefix: input.keyPrefix,
          keyHash: input.keyHash,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        }),
      );
    },
    async findByPrefix(keyPrefix: string) {
      return [...credentials.values()].find((credential) => credential.keyPrefix === keyPrefix);
    },
    async findById(tenantId: TenantId, id: ApiCredentialId) {
      const credential = credentials.get(id);
      return credential && credential.tenantId === tenantId ? stripHash(credential) : undefined;
    },
    async listByTenant(tenantId: TenantId) {
      return [...credentials.values()].filter((credential) => credential.tenantId === tenantId).map(stripHash);
    },
    async revoke(tenantId: TenantId, id: ApiCredentialId) {
      const credential = credentials.get(id);
      if (!credential || credential.tenantId !== tenantId) {
        return undefined;
      }
      const revoked: ApiCredentialWithHash = {
        ...credential,
        status: "REVOKED",
        revokedAt: credential.revokedAt ?? new Date(),
      };
      credentials.set(id, revoked);
      return stripHash(revoked);
    },
    async touchLastUsed(id: ApiCredentialId) {
      touchedLastUsedIds.push(id);
      const credential = credentials.get(id);
      if (credential) {
        credentials.set(id, { ...credential, lastUsedAt: new Date() });
      }
    },
  };
}

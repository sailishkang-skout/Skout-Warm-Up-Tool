import { randomUUID } from "node:crypto";
import type { CreateTenantInput, TenantRepository } from "../../src/modules/tenancy/application/tenant-repository.js";
import type { Tenant } from "../../src/modules/tenancy/domain/tenant.js";
import { asTenantId, type TenantId } from "../../src/shared/types/index.js";

export interface FakeTenantRepository extends TenantRepository {
  seed(tenant: Partial<Tenant> & { name: string }): Tenant;
}

/** In-memory `TenantRepository` for unit tests that must not touch a real database. */
export function createFakeTenantRepository(): FakeTenantRepository {
  const tenants = new Map<TenantId, Tenant>();

  function seed(input: Partial<Tenant> & { name: string }): Tenant {
    const tenant: Tenant = {
      id: input.id ?? asTenantId(randomUUID()),
      name: input.name,
      status: input.status ?? "ACTIVE",
      createdAt: input.createdAt ?? new Date(),
      updatedAt: input.updatedAt ?? new Date(),
    };
    tenants.set(tenant.id, tenant);
    return tenant;
  }

  return {
    seed,
    async create(input: CreateTenantInput): Promise<Tenant> {
      return seed(input);
    },
    async findById(id: TenantId): Promise<Tenant | undefined> {
      return tenants.get(id);
    },
  };
}

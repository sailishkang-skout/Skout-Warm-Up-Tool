import type { TenantId } from "../../../shared/types/index.js";
import type { Tenant, TenantStatus } from "../domain/tenant.js";

export interface CreateTenantInput {
  readonly name: string;
  readonly status?: TenantStatus;
}

/**
 * Port implemented by `infrastructure/postgres-tenant-repository.ts`.
 * Application/domain code depends only on this interface, never on `pg`.
 */
export interface TenantRepository {
  create(input: CreateTenantInput): Promise<Tenant>;
  findById(id: TenantId): Promise<Tenant | undefined>;
}

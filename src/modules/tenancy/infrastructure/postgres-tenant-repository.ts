import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asTenantId, type TenantId } from "../../../shared/types/index.js";
import type { CreateTenantInput, TenantRepository } from "../application/tenant-repository.js";
import type { Tenant, TenantStatus } from "../domain/tenant.js";

interface TenantRow {
  id: string;
  name: string;
  status: TenantStatus;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: TenantRow): Tenant {
  return {
    id: asTenantId(row.id),
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresTenantRepository implements TenantRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    const rows = await this.db.query<TenantRow>(
      `INSERT INTO tenants (name, status)
       VALUES ($1, $2)
       RETURNING id, name, status, created_at, updated_at`,
      [input.name, input.status ?? "ACTIVE"],
    );
    return mapRow(expectOne(rows, "tenants insert"));
  }

  async findById(id: TenantId): Promise<Tenant | undefined> {
    const rows = await this.db.query<TenantRow>(
      "SELECT id, name, status, created_at, updated_at FROM tenants WHERE id = $1",
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }
}

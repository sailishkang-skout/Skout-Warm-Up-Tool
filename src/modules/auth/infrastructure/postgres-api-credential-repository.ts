import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import { asApiCredentialId, asTenantId, type ApiCredentialId, type TenantId } from "../../../shared/types/index.js";
import type {
  ApiCredentialRepository,
  CreateApiCredentialInput,
} from "../application/api-credential-repository.js";
import type { ApiCredential, ApiCredentialStatus, ApiCredentialWithHash } from "../domain/api-credential.js";

interface ApiCredentialRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  status: ApiCredentialStatus;
  privilege: import("../domain/api-credential-privilege.js").ApiCredentialPrivilege;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ApiCredentialRowWithHash extends ApiCredentialRow {
  key_hash: string;
}

const SAFE_COLUMNS =
  "id, tenant_id, name, key_prefix, status, privilege, expires_at, last_used_at, revoked_at, created_at, updated_at";
const SAFE_COLUMNS_WITH_HASH = `${SAFE_COLUMNS}, key_hash`;

function mapRow(row: ApiCredentialRow): ApiCredential {
  return {
    id: asApiCredentialId(row.id),
    tenantId: asTenantId(row.tenant_id),
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    privilege: row.privilege,
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRowWithHash(row: ApiCredentialRowWithHash): ApiCredentialWithHash {
  return { ...mapRow(row), keyHash: row.key_hash };
}

export class PostgresApiCredentialRepository implements ApiCredentialRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: CreateApiCredentialInput): Promise<ApiCredential> {
    const rows = await this.db.query<ApiCredentialRow>(
      `INSERT INTO api_credentials (tenant_id, name, key_prefix, key_hash, expires_at, privilege)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SAFE_COLUMNS}`,
      [input.tenantId, input.name, input.keyPrefix, input.keyHash, input.expiresAt ?? null, input.privilege ?? "TENANT"],
    );
    return mapRow(expectOne(rows, "api_credentials insert"));
  }

  async findByPrefix(keyPrefix: string): Promise<ApiCredentialWithHash | undefined> {
    const rows = await this.db.query<ApiCredentialRowWithHash>(
      `SELECT ${SAFE_COLUMNS_WITH_HASH} FROM api_credentials WHERE key_prefix = $1`,
      [keyPrefix],
    );
    return rows[0] ? mapRowWithHash(rows[0]) : undefined;
  }

  async findById(tenantId: TenantId, id: ApiCredentialId): Promise<ApiCredential | undefined> {
    const rows = await this.db.query<ApiCredentialRow>(
      `SELECT ${SAFE_COLUMNS} FROM api_credentials WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listByTenant(tenantId: TenantId): Promise<ApiCredential[]> {
    const rows = await this.db.query<ApiCredentialRow>(
      `SELECT ${SAFE_COLUMNS} FROM api_credentials WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map(mapRow);
  }

  async revoke(tenantId: TenantId, id: ApiCredentialId): Promise<ApiCredential | undefined> {
    const rows = await this.db.query<ApiCredentialRow>(
      `UPDATE api_credentials
       SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, now())
       WHERE tenant_id = $1 AND id = $2
       RETURNING ${SAFE_COLUMNS}`,
      [tenantId, id],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async touchLastUsed(id: ApiCredentialId): Promise<void> {
    // No tenant_id filter needed: `id` is only ever the credential this
    // repository itself just resolved during authentication (a trusted,
    // server-derived value), never user/route input.
    await this.db.query("UPDATE api_credentials SET last_used_at = now() WHERE id = $1", [id]);
  }
}

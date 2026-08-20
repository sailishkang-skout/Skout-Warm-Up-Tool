import type { Database } from "../../../shared/db/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { asTenantId, type TenantId } from "../../../shared/types/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { OrganizationProviderAccount } from "../domain/organization-provider-account.js";

export interface OrganizationProviderAccountService {
  create(
    tenantId: TenantId,
    input: { provider: "GMAIL" | "MICROSOFT365"; customerDomain: string; customerDomainId?: string },
  ): Promise<OrganizationProviderAccount>;
  list(tenantId: TenantId): Promise<OrganizationProviderAccount[]>;
  get(tenantId: TenantId, id: string): Promise<OrganizationProviderAccount>;
}

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function createOrganizationProviderAccountService(deps: {
  readonly database: Database;
  readonly auditRecorder: AuditEventRecorder;
}): OrganizationProviderAccountService {
  return {
    async create(tenantId, input) {
      const domain = input.customerDomain.trim().toLowerCase();
      if (!DOMAIN_PATTERN.test(domain)) {
        throw new ValidationError("Invalid customer domain");
      }
      try {
        const rows = await deps.database.query<Row>(
          `INSERT INTO organization_provider_accounts (tenant_id, customer_domain_id, provider, customer_domain, status)
           VALUES ($1, $2, $3, $4, 'PENDING')
           RETURNING id, tenant_id, customer_domain_id, provider, provider_customer_id, customer_domain, status, created_at, updated_at`,
          [tenantId, input.customerDomainId ?? null, input.provider, domain],
        );
        const account = mapRow(rows[0]!);
        await deps.auditRecorder.record({
          tenantId,
          eventType: "PROVIDER_CONNECTED",
          actorType: "api_key",
          metadata: { organizationProviderAccountId: account.id, provider: account.provider, status: account.status },
        });
        return account;
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError("Provider account already exists for this tenant, provider, and domain");
        }
        throw error;
      }
    },

    async list(tenantId) {
      const rows = await deps.database.query<Row>(
        `SELECT id, tenant_id, customer_domain_id, provider, provider_customer_id, customer_domain, status, created_at, updated_at
           FROM organization_provider_accounts WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      return rows.map(mapRow);
    },

    async get(tenantId, id) {
      const rows = await deps.database.query<Row>(
        `SELECT id, tenant_id, customer_domain_id, provider, provider_customer_id, customer_domain, status, created_at, updated_at
           FROM organization_provider_accounts WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      if (!rows[0]) {
        throw new NotFoundError("Provider account not found");
      }
      return mapRow(rows[0]);
    },
  };
}

interface Row {
  id: string;
  tenant_id: string;
  customer_domain_id: string | null;
  provider: OrganizationProviderAccount["provider"];
  provider_customer_id: string | null;
  customer_domain: string;
  status: OrganizationProviderAccount["status"];
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: Row): OrganizationProviderAccount {
  return {
    id: row.id,
    tenantId: asTenantId(row.tenant_id),
    ...(row.customer_domain_id ? { customerDomainId: row.customer_domain_id } : {}),
    provider: row.provider,
    ...(row.provider_customer_id ? { providerCustomerId: row.provider_customer_id } : {}),
    customerDomain: row.customer_domain,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

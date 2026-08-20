import type { Database } from "../../../shared/db/index.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { asTenantId, type TenantId } from "../../../shared/types/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { CustomerDomain } from "../domain/customer-domain.js";

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export interface CustomerDomainService {
  create(tenantId: TenantId, domainName: string, provider?: CustomerDomain["provider"]): Promise<CustomerDomain>;
  list(tenantId: TenantId): Promise<CustomerDomain[]>;
  get(tenantId: TenantId, id: string): Promise<CustomerDomain>;
  applyDnsEvidence(
    tenantId: TenantId,
    id: string,
    evidence: { mx: string; spf: string; dkim: string; dmarc: string },
  ): Promise<CustomerDomain>;
}

export function createCustomerDomainService(deps: {
  readonly database: Database;
  readonly auditRecorder: AuditEventRecorder;
}): CustomerDomainService {
  return {
    async create(tenantId, domainName, provider = "UNKNOWN") {
      const normalized = domainName.trim().toLowerCase();
      if (!DOMAIN_PATTERN.test(normalized)) {
        throw new ValidationError("Invalid domain name");
      }
      try {
        const rows = await deps.database.query<CustomerDomainRow>(
          `INSERT INTO customer_domains (tenant_id, domain_name, provider, status, verification_status)
           VALUES ($1, $2, $3, 'DISCOVERED', 'UNVERIFIED')
           RETURNING ${COLUMNS}`,
          [tenantId, normalized, provider],
        );
        const domain = mapRow(rows[0]!);
        await deps.auditRecorder.record({
          tenantId,
          eventType: "DOMAIN_CREATED",
          actorType: "api_key",
          metadata: { domainId: domain.id, domainName: domain.domainName },
        });
        return domain;
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError("Domain already exists for this tenant");
        }
        throw error;
      }
    },

    async list(tenantId) {
      const rows = await deps.database.query<CustomerDomainRow>(
        `SELECT ${COLUMNS} FROM customer_domains WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      return rows.map(mapRow);
    },

    async get(tenantId, id) {
      const rows = await deps.database.query<CustomerDomainRow>(
        `SELECT ${COLUMNS} FROM customer_domains WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      if (!rows[0]) {
        throw new NotFoundError("Domain not found");
      }
      return mapRow(rows[0]);
    },

    async applyDnsEvidence(tenantId, id, evidence) {
      const current = await this.get(tenantId, id);
      const verified =
        evidence.mx === "PASS" && evidence.spf === "PASS" && evidence.dkim === "PASS" && evidence.dmarc === "PASS";
      const rows = await deps.database.query<CustomerDomainRow>(
        `UPDATE customer_domains
            SET mx_status = $3, spf_status = $4, dkim_status = $5, dmarc_status = $6, dns_status = $3,
                verification_status = $7, status = $8
          WHERE tenant_id = $1 AND id = $2
          RETURNING ${COLUMNS}`,
        [
          tenantId,
          id,
          evidence.mx,
          evidence.spf,
          evidence.dkim,
          evidence.dmarc,
          verified ? "VERIFIED" : current.verificationStatus === "VERIFIED" ? "FAILED" : "UNVERIFIED",
          verified ? "VERIFIED" : current.status,
        ],
      );
      const domain = mapRow(rows[0]!);
      if (verified) {
        incrementCounter(METRIC.mailboxProvisionAttempt);
        await deps.auditRecorder.record({
          tenantId,
          eventType: "DOMAIN_VERIFIED",
          actorType: "system",
          metadata: { domainId: domain.id, domainName: domain.domainName },
        });
      }
      return domain;
    },
  };
}

const COLUMNS =
  "id, tenant_id, domain_name, status, verification_status, provider, dns_status, spf_status, dkim_status, dmarc_status, mx_status, created_at, updated_at";

interface CustomerDomainRow {
  id: string;
  tenant_id: string;
  domain_name: string;
  status: CustomerDomain["status"];
  verification_status: CustomerDomain["verificationStatus"];
  provider: CustomerDomain["provider"];
  dns_status: string;
  spf_status: string;
  dkim_status: string;
  dmarc_status: string;
  mx_status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CustomerDomainRow): CustomerDomain {
  return {
    id: row.id,
    tenantId: asTenantId(row.tenant_id),
    domainName: row.domain_name,
    status: row.status,
    verificationStatus: row.verification_status,
    provider: row.provider,
    dnsStatus: row.dns_status,
    spfStatus: row.spf_status,
    dkimStatus: row.dkim_status,
    dmarcStatus: row.dmarc_status,
    mxStatus: row.mx_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

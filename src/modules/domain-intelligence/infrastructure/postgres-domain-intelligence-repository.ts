import type { Database } from "../../../shared/db/index.js";
import type {
  DkimCheckResult,
  DmarcCheckResult,
  DmarcPolicy,
  DnsCheckStatus,
  DomainAuthenticationAssessment,
  MxCheckResult,
  SpfCheckResult,
} from "../domain/domain-authentication.js";
import type { DomainIntelligenceRepository } from "../application/domain-intelligence-repository.js";

interface DomainIntelligenceRow {
  domain: string;
  mx_status: DnsCheckStatus;
  mx_records: string[];
  spf_status: DnsCheckStatus;
  spf_record: string | null;
  dkim_status: DnsCheckStatus;
  dkim_selector: string | null;
  dmarc_status: DnsCheckStatus;
  dmarc_policy: DmarcPolicy | null;
  dmarc_record: string | null;
  checked_at: Date;
}

const SELECT_COLUMNS =
  "domain, mx_status, mx_records, spf_status, spf_record, dkim_status, dkim_selector, dmarc_status, dmarc_policy, dmarc_record, checked_at";

function mapRow(row: DomainIntelligenceRow): DomainAuthenticationAssessment {
  const mx: MxCheckResult = { status: row.mx_status, records: row.mx_records };
  const spf: SpfCheckResult = { status: row.spf_status, ...(row.spf_record ? { record: row.spf_record } : {}) };
  const dkim: DkimCheckResult = {
    status: row.dkim_status,
    ...(row.dkim_selector ? { selector: row.dkim_selector } : {}),
  };
  const dmarc: DmarcCheckResult = {
    status: row.dmarc_status,
    ...(row.dmarc_policy ? { policy: row.dmarc_policy } : {}),
    ...(row.dmarc_record ? { record: row.dmarc_record } : {}),
  };

  return { domain: row.domain, mx, spf, dkim, dmarc, checkedAt: row.checked_at };
}

/** One row per domain, upserted — see migrations/009_create_domain_intelligence.sql for why this table holds no history. */
export function createPostgresDomainIntelligenceRepository(database: Database): DomainIntelligenceRepository {
  return {
    async findByDomain(domain: string): Promise<DomainAuthenticationAssessment | undefined> {
      const rows = await database.query<DomainIntelligenceRow>(
        `SELECT ${SELECT_COLUMNS} FROM domain_intelligence WHERE domain = $1`,
        [domain],
      );
      return rows[0] ? mapRow(rows[0]) : undefined;
    },

    async upsert(assessment: DomainAuthenticationAssessment): Promise<void> {
      await database.query(
        `INSERT INTO domain_intelligence
           (domain, mx_status, mx_records, spf_status, spf_record, dkim_status, dkim_selector, dmarc_status, dmarc_policy, dmarc_record, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (domain) DO UPDATE SET
           mx_status = EXCLUDED.mx_status,
           mx_records = EXCLUDED.mx_records,
           spf_status = EXCLUDED.spf_status,
           spf_record = EXCLUDED.spf_record,
           dkim_status = EXCLUDED.dkim_status,
           dkim_selector = EXCLUDED.dkim_selector,
           dmarc_status = EXCLUDED.dmarc_status,
           dmarc_policy = EXCLUDED.dmarc_policy,
           dmarc_record = EXCLUDED.dmarc_record,
           checked_at = EXCLUDED.checked_at`,
        [
          assessment.domain,
          assessment.mx.status,
          JSON.stringify(assessment.mx.records),
          assessment.spf.status,
          assessment.spf.record ?? null,
          assessment.dkim.status,
          assessment.dkim.selector ?? null,
          assessment.dmarc.status,
          assessment.dmarc.policy ?? null,
          assessment.dmarc.record ?? null,
          assessment.checkedAt,
        ],
      );
    },
  };
}

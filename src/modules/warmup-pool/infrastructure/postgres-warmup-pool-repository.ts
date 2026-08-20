import { expectOne, type DatabaseClient } from "../../../shared/db/index.js";
import type { HealthStatus } from "../../health/domain/mailbox-health.js";
import type { MailboxStatus } from "../../mailbox/domain/mailbox.js";
import type { ReputationStatus } from "../../reputation/domain/reputation-assessment.js";
import type { RiskLevel } from "../../risk/domain/risk-assessment.js";
import {
  asMailboxId,
  asTenantId,
  asWarmupPoolId,
  asWarmupPoolMembershipId,
  type MailboxId,
  type TenantId,
  type WarmupPoolId,
} from "../../../shared/types/index.js";
import { emailDomain, type WarmupPool, type WarmupPoolStatus, type WarmupPoolStrategy } from "../domain/warmup-pool.js";
import type { WarmupPoolMembership, WarmupPoolMembershipStatus } from "../domain/warmup-pool-membership.js";
import type { WarmupPoolCandidate } from "../application/warmup-pool-eligibility.js";
import type {
  AddWarmupPoolMembershipInput,
  ApplySelectionInput,
  CreateWarmupPoolInput,
  PatchWarmupPoolInput,
  WarmupPoolHealthSnapshot,
  WarmupPoolRepository,
} from "../application/warmup-pool-repository.js";

interface PoolRow {
  id: string;
  tenant_id: string;
  name: string;
  status: WarmupPoolStatus;
  strategy: WarmupPoolStrategy;
  max_consecutive_same_domain: number;
  max_domain_share_percent: number;
  last_selected_mailbox_id: string | null;
  last_selected_domain: string | null;
  consecutive_same_domain: number;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  id: string;
  pool_id: string;
  mailbox_id: string;
  tenant_id: string;
  status: WarmupPoolMembershipStatus;
  priority: number;
  weight: number;
  max_daily_warmup_volume: number | null;
  current_daily_warmup_volume: number;
  usage_date: string;
  last_selected_at: Date | null;
  cooldown_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CandidateRow extends MembershipRow {
  mailbox_status: MailboxStatus;
  mailbox_enabled: boolean;
  email_address_canonical: string;
  credential_available: boolean;
  provider_account_status: string | null;
  connection_health: HealthStatus | null;
  authentication_health: HealthStatus | null;
  sending_health: HealthStatus | null;
  domain_health: HealthStatus | null;
  risk_level: RiskLevel | null;
  reputation_status: ReputationStatus | null;
}

const POOL_COLUMNS = `
  id, tenant_id, name, status, strategy, max_consecutive_same_domain, max_domain_share_percent,
  last_selected_mailbox_id, last_selected_domain, consecutive_same_domain, created_at, updated_at
`;

const MEMBERSHIP_COLUMNS = `
  id, pool_id, mailbox_id, tenant_id, status, priority, weight, max_daily_warmup_volume,
  current_daily_warmup_volume, usage_date::text AS usage_date, last_selected_at, cooldown_until,
  created_at, updated_at
`;

function mapPool(row: PoolRow): WarmupPool {
  return {
    id: asWarmupPoolId(row.id),
    tenantId: asTenantId(row.tenant_id),
    name: row.name,
    status: row.status,
    strategy: row.strategy,
    maxConsecutiveSameDomain: row.max_consecutive_same_domain,
    maxDomainSharePercent: row.max_domain_share_percent,
    ...(row.last_selected_mailbox_id ? { lastSelectedMailboxId: asMailboxId(row.last_selected_mailbox_id) } : {}),
    ...(row.last_selected_domain ? { lastSelectedDomain: row.last_selected_domain } : {}),
    consecutiveSameDomain: row.consecutive_same_domain,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembership(row: MembershipRow): WarmupPoolMembership {
  return {
    id: asWarmupPoolMembershipId(row.id),
    poolId: asWarmupPoolId(row.pool_id),
    mailboxId: asMailboxId(row.mailbox_id),
    tenantId: asTenantId(row.tenant_id),
    status: row.status,
    priority: row.priority,
    weight: row.weight,
    ...(row.max_daily_warmup_volume !== null ? { maxDailyWarmupVolume: row.max_daily_warmup_volume } : {}),
    currentDailyWarmupVolume: row.current_daily_warmup_volume,
    usageDate: row.usage_date,
    ...(row.last_selected_at ? { lastSelectedAt: row.last_selected_at } : {}),
    ...(row.cooldown_until ? { cooldownUntil: row.cooldown_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: CandidateRow): WarmupPoolCandidate {
  return {
    membership: mapMembership(row),
    mailboxStatus: row.mailbox_status,
    mailboxEnabled: row.mailbox_enabled,
    emailDomain: emailDomain(row.email_address_canonical),
    credentialAvailable: row.credential_available,
    ...(row.provider_account_status ? { providerAccountStatus: row.provider_account_status } : {}),
    ...(row.connection_health ? { connectionHealth: row.connection_health } : {}),
    ...(row.authentication_health ? { authenticationHealth: row.authentication_health } : {}),
    ...(row.sending_health ? { sendingHealth: row.sending_health } : {}),
    ...(row.domain_health ? { domainHealth: row.domain_health } : {}),
    ...(row.risk_level ? { riskLevel: row.risk_level } : {}),
    ...(row.reputation_status ? { reputationStatus: row.reputation_status } : {}),
  };
}

export class PostgresWarmupPoolRepository implements WarmupPoolRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createPool(input: CreateWarmupPoolInput): Promise<WarmupPool> {
    const rows = await this.db.query<PoolRow>(
      `INSERT INTO warmup_pools (tenant_id, name, strategy, max_consecutive_same_domain, max_domain_share_percent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${POOL_COLUMNS}`,
      [input.tenantId, input.name, input.strategy, input.maxConsecutiveSameDomain, input.maxDomainSharePercent],
    );
    return mapPool(expectOne(rows, "warmup_pools insert"));
  }

  async listPools(tenantId: TenantId): Promise<WarmupPool[]> {
    const rows = await this.db.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM warmup_pools WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map(mapPool);
  }

  async getPool(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPool | undefined> {
    const rows = await this.db.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM warmup_pools WHERE tenant_id = $1 AND id = $2`,
      [tenantId, poolId],
    );
    return rows[0] ? mapPool(rows[0]) : undefined;
  }

  async patchPool(tenantId: TenantId, poolId: WarmupPoolId, input: PatchWarmupPoolInput): Promise<WarmupPool | undefined> {
    const rows = await this.db.query<PoolRow>(
      `UPDATE warmup_pools
          SET name = COALESCE($3, name),
              status = COALESCE($4, status),
              strategy = COALESCE($5, strategy),
              max_consecutive_same_domain = COALESCE($6, max_consecutive_same_domain),
              max_domain_share_percent = COALESCE($7, max_domain_share_percent)
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${POOL_COLUMNS}`,
      [
        tenantId,
        poolId,
        input.name ?? null,
        input.status ?? null,
        input.strategy ?? null,
        input.maxConsecutiveSameDomain ?? null,
        input.maxDomainSharePercent ?? null,
      ],
    );
    return rows[0] ? mapPool(rows[0]) : undefined;
  }

  async addMembership(input: AddWarmupPoolMembershipInput): Promise<WarmupPoolMembership> {
    const rows = await this.db.query<MembershipRow>(
      `INSERT INTO warmup_pool_memberships (
         pool_id, mailbox_id, tenant_id, status, priority, weight, max_daily_warmup_volume
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${MEMBERSHIP_COLUMNS}`,
      [
        input.poolId,
        input.mailboxId,
        input.tenantId,
        input.status ?? "AVAILABLE",
        input.priority ?? 0,
        input.weight ?? 1,
        input.maxDailyWarmupVolume ?? null,
      ],
    );
    return mapMembership(expectOne(rows, "warmup_pool_memberships insert"));
  }

  async listMemberships(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolMembership[]> {
    const rows = await this.db.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS}
         FROM warmup_pool_memberships
        WHERE tenant_id = $1 AND pool_id = $2
        ORDER BY id`,
      [tenantId, poolId],
    );
    return rows.map(mapMembership);
  }

  async findActivePoolForMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupPool | undefined> {
    const rows = await this.db.query<PoolRow>(
      `SELECT p.id, p.tenant_id, p.name, p.status, p.strategy, p.max_consecutive_same_domain, p.max_domain_share_percent,
              p.last_selected_mailbox_id, p.last_selected_domain, p.consecutive_same_domain, p.created_at, p.updated_at
         FROM warmup_pools p
         JOIN warmup_pool_memberships m ON m.pool_id = p.id
        WHERE p.tenant_id = $1
          AND m.tenant_id = $1
          AND m.mailbox_id = $2
          AND p.status = 'ACTIVE'
          AND m.status IN ('AVAILABLE', 'ACTIVE')
        ORDER BY p.created_at
        LIMIT 1`,
      [tenantId, mailboxId],
    );
    return rows[0] ? mapPool(rows[0]) : undefined;
  }

  async getHealth(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolHealthSnapshot | undefined> {
    const pool = await this.getPool(tenantId, poolId);
    if (!pool) {
      return undefined;
    }
    const rows = await this.db.query<{ status: WarmupPoolMembershipStatus; count: string }>(
      `SELECT status, COUNT(*)::text AS count
         FROM warmup_pool_memberships
        WHERE tenant_id = $1 AND pool_id = $2
        GROUP BY status`,
      [tenantId, poolId],
    );
    const membershipsByStatus: Record<WarmupPoolMembershipStatus, number> = {
      AVAILABLE: 0,
      ACTIVE: 0,
      COOLDOWN: 0,
      DRAINING: 0,
      DISABLED: 0,
    };
    let memberships = 0;
    for (const row of rows) {
      membershipsByStatus[row.status] = Number(row.count);
      memberships += Number(row.count);
    }
    return {
      poolId: pool.id,
      status: pool.status,
      memberships,
      eligibleEstimate: membershipsByStatus.AVAILABLE + membershipsByStatus.ACTIVE,
      membershipsByStatus,
    };
  }

  async lockPoolAndCandidates(
    client: DatabaseClient,
    tenantId: TenantId,
    poolId: WarmupPoolId,
  ): Promise<{ pool: WarmupPool; candidates: WarmupPoolCandidate[] } | undefined> {
    const poolRows = await client.query<PoolRow>(
      `SELECT ${POOL_COLUMNS} FROM warmup_pools WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, poolId],
    );
    if (!poolRows[0]) {
      return undefined;
    }
    await client.query(
      `SELECT id FROM warmup_pool_memberships WHERE tenant_id = $1 AND pool_id = $2 ORDER BY id FOR UPDATE`,
      [tenantId, poolId],
    );
    const rows = await client.query<CandidateRow>(
      `SELECT m.id, m.pool_id, m.mailbox_id, m.tenant_id, m.status, m.priority, m.weight, m.max_daily_warmup_volume,
              m.current_daily_warmup_volume, m.usage_date::text AS usage_date, m.last_selected_at, m.cooldown_until,
              m.created_at, m.updated_at,
              mb.status AS mailbox_status, mb.enabled AS mailbox_enabled, mb.email_address_canonical,
              EXISTS (
                SELECT 1
                  FROM provider_accounts pa
                  JOIN provider_credentials pc ON pc.provider_account_id = pa.id AND pc.status = 'ACTIVE'
                 WHERE pa.mailbox_id = m.mailbox_id AND pa.tenant_id = m.tenant_id
              ) AS credential_available,
              pa.status AS provider_account_status,
              a.connection_health, a.authentication_health, a.sending_health, a.domain_health, a.risk_level,
              r.status AS reputation_status
         FROM warmup_pool_memberships m
         JOIN mailboxes mb ON mb.id = m.mailbox_id AND mb.tenant_id = m.tenant_id
         LEFT JOIN provider_accounts pa ON pa.mailbox_id = m.mailbox_id AND pa.tenant_id = m.tenant_id
         LEFT JOIN LATERAL (
           SELECT connection_health, authentication_health, sending_health, domain_health, risk_level
             FROM mailbox_assessments
            WHERE tenant_id = m.tenant_id AND mailbox_id = m.mailbox_id
            ORDER BY assessed_at DESC
            LIMIT 1
         ) a ON true
         LEFT JOIN LATERAL (
           SELECT status
             FROM reputation_assessments
            WHERE tenant_id = m.tenant_id AND mailbox_id = m.mailbox_id
            ORDER BY created_at DESC
            LIMIT 1
         ) r ON true
        WHERE m.tenant_id = $1 AND m.pool_id = $2
        ORDER BY m.id`,
      [tenantId, poolId],
    );
    return { pool: mapPool(poolRows[0]), candidates: rows.map(mapCandidate) };
  }

  async applySelection(client: DatabaseClient, input: ApplySelectionInput): Promise<void> {
    const usageDate = input.now.toISOString().slice(0, 10);
    await client.query(
      `UPDATE warmup_pool_memberships
          SET status = CASE WHEN status = 'AVAILABLE' THEN 'ACTIVE' ELSE status END,
              current_daily_warmup_volume = CASE WHEN usage_date = $3::date THEN current_daily_warmup_volume + 1 ELSE 1 END,
              usage_date = $3::date,
              last_selected_at = $4,
              cooldown_until = $5
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.membershipId, usageDate, input.now, input.cooldownUntil ?? null],
    );
    await client.query(
      `UPDATE warmup_pools
          SET last_selected_mailbox_id = $3,
              consecutive_same_domain = CASE
                WHEN last_selected_domain = $4 THEN consecutive_same_domain + 1
                ELSE 1
              END,
              last_selected_domain = $4
        WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.poolId, input.mailboxId, input.domain],
    );
  }

  async noteIntentBoundToMailbox(tenantId: TenantId, mailboxId: MailboxId, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE warmup_pool_memberships
          SET last_selected_at = $3
        WHERE tenant_id = $1
          AND mailbox_id = $2
          AND status IN ('AVAILABLE', 'ACTIVE')`,
      [tenantId, mailboxId, now],
    );
  }
}

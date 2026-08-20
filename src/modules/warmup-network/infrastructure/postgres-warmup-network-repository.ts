import type { DatabaseClient } from "../../../shared/db/index.js";
import {
  asMailboxId,
  asTenantId,
  asWarmupNetworkDomainId,
  asWarmupNetworkId,
  asWarmupNetworkMailboxId,
  asWarmupNetworkPoolId,
  asWarmupNetworkRoutingDecisionId,
  type WarmupNetworkDomainId,
  type WarmupNetworkMailboxId,
} from "../../../shared/types/index.js";
import type { WarmupNetworkDomain } from "../domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import type { WarmupNetworkRoutingDecision } from "../domain/warmup-network-routing.js";
import type { WarmupNetworkAuthStatus, WarmupNetworkCapacityStatus, WarmupNetworkEntityStatus, WarmupNetworkInfraStatus, WarmupNetworkProvider, WarmupNetworkReputationStatus } from "../domain/warmup-network-status.js";
import type {
  InsertRoutingDecisionInput,
  WarmupNetworkCandidate,
  WarmupNetworkHealthSnapshot,
  WarmupNetworkRepository,
} from "../application/warmup-network-repository.js";

interface DomainRow {
  id: string;
  network_id: string;
  pool_id: string;
  domain: string;
  provider: WarmupNetworkProvider;
  status: WarmupNetworkEntityStatus;
  authentication_status: WarmupNetworkAuthStatus;
  spf_status: WarmupNetworkAuthStatus;
  dkim_status: WarmupNetworkAuthStatus;
  dmarc_status: WarmupNetworkAuthStatus;
  reputation_status: WarmupNetworkReputationStatus;
  health_score: number;
  capacity_status: WarmupNetworkCapacityStatus;
  daily_capacity: number;
  usage_date: string;
  usage_count: number;
  cooldown_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MailboxRow {
  id: string;
  domain_id: string;
  pool_id: string;
  mailbox_id: string;
  provider: WarmupNetworkProvider;
  provider_mailbox_identifier: string;
  mailbox_address: string;
  status: WarmupNetworkEntityStatus;
  health_score: number;
  reputation_state: WarmupNetworkReputationStatus;
  daily_capacity: number;
  usage_date: string;
  usage_count: number;
  last_successful_interaction_at: Date | null;
  last_failure_at: Date | null;
  cooldown_until: Date | null;
  credential_available: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CandidateRow extends MailboxRow {
  d_id: string;
  d_network_id: string;
  d_pool_id: string;
  d_domain: string;
  d_provider: WarmupNetworkProvider;
  d_status: WarmupNetworkEntityStatus;
  d_authentication_status: WarmupNetworkAuthStatus;
  d_spf_status: WarmupNetworkAuthStatus;
  d_dkim_status: WarmupNetworkAuthStatus;
  d_dmarc_status: WarmupNetworkAuthStatus;
  d_reputation_status: WarmupNetworkReputationStatus;
  d_health_score: number;
  d_capacity_status: WarmupNetworkCapacityStatus;
  d_daily_capacity: number;
  d_usage_date: string;
  d_usage_count: number;
  d_cooldown_until: Date | null;
  d_created_at: Date;
  d_updated_at: Date;
  linked_status: string;
  linked_enabled: boolean;
  network_status: WarmupNetworkInfraStatus;
  pool_status: WarmupNetworkInfraStatus;
}

interface DecisionRow {
  id: string;
  routing_request_key: string;
  customer_tenant_id: string;
  customer_mailbox_id: string;
  selected_network_mailbox_id: string | null;
  selected_domain_id: string | null;
  outcome: WarmupNetworkRoutingDecision["outcome"];
  reason: string;
  eligibility_summary: Record<string, unknown>;
  created_at: Date;
}

const DOMAIN_COLUMNS = `
  id, network_id, pool_id, domain, provider, status, authentication_status,
  spf_status, dkim_status, dmarc_status, reputation_status, health_score,
  capacity_status, daily_capacity, usage_date::text AS usage_date, usage_count,
  cooldown_until, created_at, updated_at
`;

const MAILBOX_COLUMNS = `
  id, domain_id, pool_id, mailbox_id, provider, provider_mailbox_identifier, mailbox_address,
  status, health_score, reputation_state, daily_capacity, usage_date::text AS usage_date,
  usage_count, last_successful_interaction_at, last_failure_at, cooldown_until,
  credential_available, created_at, updated_at
`;

function mapDomain(row: DomainRow): WarmupNetworkDomain {
  return {
    id: asWarmupNetworkDomainId(row.id),
    networkId: asWarmupNetworkId(row.network_id),
    poolId: asWarmupNetworkPoolId(row.pool_id),
    domain: row.domain,
    provider: row.provider,
    status: row.status,
    authenticationStatus: row.authentication_status,
    spfStatus: row.spf_status,
    dkimStatus: row.dkim_status,
    dmarcStatus: row.dmarc_status,
    reputationStatus: row.reputation_status,
    healthScore: row.health_score,
    capacityStatus: row.capacity_status,
    dailyCapacity: row.daily_capacity,
    usageDate: row.usage_date,
    usageCount: row.usage_count,
    ...(row.cooldown_until ? { cooldownUntil: row.cooldown_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMailbox(row: MailboxRow): WarmupNetworkMailbox {
  return {
    id: asWarmupNetworkMailboxId(row.id),
    domainId: asWarmupNetworkDomainId(row.domain_id),
    poolId: asWarmupNetworkPoolId(row.pool_id),
    mailboxId: asMailboxId(row.mailbox_id),
    provider: row.provider,
    providerMailboxIdentifier: row.provider_mailbox_identifier,
    mailboxAddress: row.mailbox_address,
    status: row.status,
    healthScore: row.health_score,
    reputationState: row.reputation_state,
    dailyCapacity: row.daily_capacity,
    usageDate: row.usage_date,
    usageCount: row.usage_count,
    ...(row.last_successful_interaction_at ? { lastSuccessfulInteractionAt: row.last_successful_interaction_at } : {}),
    ...(row.last_failure_at ? { lastFailureAt: row.last_failure_at } : {}),
    ...(row.cooldown_until ? { cooldownUntil: row.cooldown_until } : {}),
    credentialAvailable: row.credential_available,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDecision(row: DecisionRow): WarmupNetworkRoutingDecision {
  return {
    id: asWarmupNetworkRoutingDecisionId(row.id),
    routingRequestKey: row.routing_request_key,
    customerTenantId: asTenantId(row.customer_tenant_id),
    customerMailboxId: asMailboxId(row.customer_mailbox_id),
    ...(row.selected_network_mailbox_id ? { selectedNetworkMailboxId: asWarmupNetworkMailboxId(row.selected_network_mailbox_id) } : {}),
    ...(row.selected_domain_id ? { selectedDomainId: asWarmupNetworkDomainId(row.selected_domain_id) } : {}),
    outcome: row.outcome,
    reason: row.reason,
    eligibilitySummary: row.eligibility_summary ?? {},
    createdAt: row.created_at,
  };
}

function emptyStatusCounts(): Record<WarmupNetworkEntityStatus, number> {
  return { ACTIVE: 0, DEGRADED: 0, COOLDOWN: 0, QUARANTINED: 0, DISABLED: 0 };
}

export class PostgresWarmupNetworkRepository implements WarmupNetworkRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findDecisionByRequestKey(client: DatabaseClient, routingRequestKey: string): Promise<WarmupNetworkRoutingDecision | undefined> {
    const rows = await client.query<DecisionRow>(
      `SELECT id, routing_request_key, customer_tenant_id, customer_mailbox_id, selected_network_mailbox_id,
              selected_domain_id, outcome, reason, eligibility_summary, created_at
         FROM warmup_network_routing_decisions
        WHERE routing_request_key = $1`,
      [routingRequestKey],
    );
    return rows[0] ? mapDecision(rows[0]) : undefined;
  }

  async lockRoutingRequestKey(client: DatabaseClient, routingRequestKey: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(87210921, hashtext($1::text))`, [routingRequestKey]);
  }

  async lockCandidatesForUpdate(client: DatabaseClient): Promise<WarmupNetworkCandidate[]> {
    const mailboxIds = await client.query<{ id: string }>(
      `SELECT id FROM warmup_network_mailboxes ORDER BY id FOR UPDATE`,
    );
    await client.query(`SELECT id FROM warmup_network_domains ORDER BY id FOR UPDATE`);

    if (mailboxIds.length === 0) {
      return [];
    }

    const rows = await client.query<CandidateRow>(
      `SELECT m.id, m.domain_id, m.pool_id, m.mailbox_id, m.provider, m.provider_mailbox_identifier, m.mailbox_address,
              m.status, m.health_score, m.reputation_state, m.daily_capacity, m.usage_date::text AS usage_date,
              m.usage_count, m.last_successful_interaction_at, m.last_failure_at, m.cooldown_until,
              m.credential_available, m.created_at, m.updated_at,
              d.id AS d_id, d.network_id AS d_network_id, d.pool_id AS d_pool_id, d.domain AS d_domain,
              d.provider AS d_provider, d.status AS d_status, d.authentication_status AS d_authentication_status,
              d.spf_status AS d_spf_status, d.dkim_status AS d_dkim_status, d.dmarc_status AS d_dmarc_status,
              d.reputation_status AS d_reputation_status, d.health_score AS d_health_score,
              d.capacity_status AS d_capacity_status, d.daily_capacity AS d_daily_capacity,
              d.usage_date::text AS d_usage_date, d.usage_count AS d_usage_count, d.cooldown_until AS d_cooldown_until,
              d.created_at AS d_created_at, d.updated_at AS d_updated_at,
              lm.status AS linked_status, lm.enabled AS linked_enabled,
              n.status AS network_status, p.status AS pool_status
         FROM warmup_network_mailboxes m
         JOIN warmup_network_domains d ON d.id = m.domain_id
         JOIN warmup_network_pools p ON p.id = m.pool_id
         JOIN warmup_networks n ON n.id = d.network_id
         JOIN mailboxes lm ON lm.id = m.mailbox_id
        ORDER BY m.id`,
    );

    return rows.map((row) => ({
      mailbox: mapMailbox(row),
      domain: mapDomain({
        id: row.d_id,
        network_id: row.d_network_id,
        pool_id: row.d_pool_id,
        domain: row.d_domain,
        provider: row.d_provider,
        status: row.d_status,
        authentication_status: row.d_authentication_status,
        spf_status: row.d_spf_status,
        dkim_status: row.d_dkim_status,
        dmarc_status: row.d_dmarc_status,
        reputation_status: row.d_reputation_status,
        health_score: row.d_health_score,
        capacity_status: row.d_capacity_status,
        daily_capacity: row.d_daily_capacity,
        usage_date: row.d_usage_date,
        usage_count: row.d_usage_count,
        cooldown_until: row.d_cooldown_until,
        created_at: row.d_created_at,
        updated_at: row.d_updated_at,
      }),
      linkedMailboxStatus: row.linked_status,
      linkedMailboxEnabled: row.linked_enabled,
      networkStatus: row.network_status,
      poolStatus: row.pool_status,
    }));
  }

  async listRecentSelectedMailboxIds(
    client: DatabaseClient,
    customerMailboxId: import("../../../shared/types/index.js").MailboxId,
    since: Date,
  ): Promise<WarmupNetworkMailboxId[]> {
    const rows = await client.query<{ selected_network_mailbox_id: string }>(
      `SELECT selected_network_mailbox_id
         FROM warmup_network_routing_decisions
        WHERE customer_mailbox_id = $1
          AND outcome = 'SELECTED'
          AND selected_network_mailbox_id IS NOT NULL
          AND created_at >= $2
        ORDER BY created_at DESC`,
      [customerMailboxId, since],
    );
    return rows.map((row) => asWarmupNetworkMailboxId(row.selected_network_mailbox_id));
  }

  async insertDecision(client: DatabaseClient, input: InsertRoutingDecisionInput): Promise<WarmupNetworkRoutingDecision> {
    const inserted = await client.query<DecisionRow>(
      `INSERT INTO warmup_network_routing_decisions (
         routing_request_key, customer_tenant_id, customer_mailbox_id,
         selected_network_mailbox_id, selected_domain_id, outcome, reason, eligibility_summary
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (routing_request_key) DO NOTHING
       RETURNING id, routing_request_key, customer_tenant_id, customer_mailbox_id, selected_network_mailbox_id,
                 selected_domain_id, outcome, reason, eligibility_summary, created_at`,
      [
        input.routingRequestKey,
        input.customerTenantId,
        input.customerMailboxId,
        input.selectedNetworkMailboxId ?? null,
        input.selectedDomainId ?? null,
        input.outcome,
        input.reason,
        JSON.stringify(input.eligibilitySummary),
      ],
    );
    if (inserted[0]) {
      return mapDecision(inserted[0]);
    }
    const existing = await this.findDecisionByRequestKey(client, input.routingRequestKey);
    if (!existing) {
      throw new Error("routing decision insert conflicted but no existing row was found");
    }
    return existing;
  }

  async reserveUsage(
    client: DatabaseClient,
    mailboxId: WarmupNetworkMailboxId,
    domainId: WarmupNetworkDomainId,
    usageDate: string,
  ): Promise<boolean> {
    const mailboxRows = await client.query<{ id: string }>(
      `UPDATE warmup_network_mailboxes
          SET usage_count = CASE WHEN usage_date = $2::date THEN usage_count + 1 ELSE 1 END,
              usage_date = $2::date
        WHERE id = $1
          AND (usage_date <> $2::date OR usage_count < daily_capacity)
        RETURNING id`,
      [mailboxId, usageDate],
    );
    if (!mailboxRows[0]) {
      return false;
    }
    const domainRows = await client.query<{ id: string }>(
      `UPDATE warmup_network_domains
          SET usage_count = CASE WHEN usage_date = $2::date THEN usage_count + 1 ELSE 1 END,
              usage_date = $2::date,
              capacity_status = CASE
                WHEN (CASE WHEN usage_date = $2::date THEN usage_count + 1 ELSE 1 END) >= daily_capacity THEN 'EXHAUSTED'
                ELSE 'AVAILABLE'
              END
        WHERE id = $1
          AND (usage_date <> $2::date OR usage_count < daily_capacity)
        RETURNING id`,
      [domainId, usageDate],
    );
    if (!domainRows[0]) {
      throw new Error("warmup network domain capacity reservation failed after mailbox reservation");
    }
    return true;
  }

  async recordSuccessfulInteraction(mailboxId: WarmupNetworkMailboxId, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE warmup_network_mailboxes SET last_successful_interaction_at = $2 WHERE id = $1`,
      [mailboxId, at],
    );
  }

  async markCredentialUnavailable(mailboxId: WarmupNetworkMailboxId, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE warmup_network_mailboxes
          SET credential_available = false, last_failure_at = $2
        WHERE id = $1`,
      [mailboxId, at],
    );
  }

  async listDomains(): Promise<WarmupNetworkDomain[]> {
    const rows = await this.db.query<DomainRow>(`SELECT ${DOMAIN_COLUMNS} FROM warmup_network_domains ORDER BY domain`);
    return rows.map(mapDomain);
  }

  async getDomain(id: WarmupNetworkDomainId): Promise<WarmupNetworkDomain | undefined> {
    const rows = await this.db.query<DomainRow>(`SELECT ${DOMAIN_COLUMNS} FROM warmup_network_domains WHERE id = $1`, [id]);
    return rows[0] ? mapDomain(rows[0]) : undefined;
  }

  async listMailboxes(): Promise<WarmupNetworkMailbox[]> {
    const rows = await this.db.query<MailboxRow>(
      `SELECT ${MAILBOX_COLUMNS} FROM warmup_network_mailboxes ORDER BY mailbox_address`,
    );
    return rows.map(mapMailbox);
  }

  async getMailbox(id: WarmupNetworkMailboxId, client: DatabaseClient = this.db): Promise<WarmupNetworkMailbox | undefined> {
    const rows = await client.query<MailboxRow>(`SELECT ${MAILBOX_COLUMNS} FROM warmup_network_mailboxes WHERE id = $1`, [id]);
    return rows[0] ? mapMailbox(rows[0]) : undefined;
  }

  async getHealth(): Promise<WarmupNetworkHealthSnapshot> {
    const [networks, domains, mailboxes] = await Promise.all([
      this.db.query<{ total: string; active: string }>(
        `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE')::text AS active FROM warmup_networks`,
      ),
      this.db.query<{ status: WarmupNetworkEntityStatus; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM warmup_network_domains GROUP BY status`,
      ),
      this.db.query<{
        status: WarmupNetworkEntityStatus;
        count: string;
        credential_unavailable: string;
        remaining: string;
      }>(
        `SELECT status, COUNT(*)::text AS count,
                COUNT(*) FILTER (WHERE credential_available = false)::text AS credential_unavailable,
                COALESCE(SUM(GREATEST(daily_capacity - CASE WHEN usage_date = (timezone('utc', now()))::date THEN usage_count ELSE 0 END, 0)), 0)::text AS remaining
           FROM warmup_network_mailboxes
          GROUP BY status`,
      ),
    ]);

    const domainsByStatus = emptyStatusCounts();
    let domainTotal = 0;
    for (const row of domains) {
      domainsByStatus[row.status] = Number(row.count);
      domainTotal += Number(row.count);
    }
    const mailboxesByStatus = emptyStatusCounts();
    let mailboxTotal = 0;
    let credentialUnavailable = 0;
    let remainingMailboxCapacityToday = 0;
    for (const row of mailboxes) {
      mailboxesByStatus[row.status] = Number(row.count);
      mailboxTotal += Number(row.count);
      credentialUnavailable += Number(row.credential_unavailable);
      remainingMailboxCapacityToday += Number(row.remaining);
    }

    return {
      networks: Number(networks[0]?.total ?? 0),
      activeNetworks: Number(networks[0]?.active ?? 0),
      domains: domainTotal,
      domainsByStatus,
      mailboxes: mailboxTotal,
      mailboxesByStatus,
      credentialUnavailable,
      remainingMailboxCapacityToday,
    };
  }
}

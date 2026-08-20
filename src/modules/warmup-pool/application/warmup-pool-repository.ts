import type { DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, TenantId, WarmupPoolId, WarmupPoolMembershipId } from "../../../shared/types/index.js";
import type { WarmupPool, WarmupPoolStatus, WarmupPoolStrategy } from "../domain/warmup-pool.js";
import type { WarmupPoolMembership, WarmupPoolMembershipStatus } from "../domain/warmup-pool-membership.js";
import type { WarmupPoolCandidate } from "./warmup-pool-eligibility.js";

export interface CreateWarmupPoolInput {
  readonly tenantId: TenantId;
  readonly name: string;
  readonly strategy: WarmupPoolStrategy;
  readonly maxConsecutiveSameDomain: number;
  readonly maxDomainSharePercent: number;
}

export interface PatchWarmupPoolInput {
  readonly name?: string;
  readonly status?: WarmupPoolStatus;
  readonly strategy?: WarmupPoolStrategy;
  readonly maxConsecutiveSameDomain?: number;
  readonly maxDomainSharePercent?: number;
}

export interface AddWarmupPoolMembershipInput {
  readonly tenantId: TenantId;
  readonly poolId: WarmupPoolId;
  readonly mailboxId: MailboxId;
  readonly status?: WarmupPoolMembershipStatus;
  readonly priority?: number;
  readonly weight?: number;
  readonly maxDailyWarmupVolume?: number;
}

export interface ApplySelectionInput {
  readonly tenantId: TenantId;
  readonly poolId: WarmupPoolId;
  readonly membershipId: WarmupPoolMembershipId;
  readonly mailboxId: MailboxId;
  readonly domain: string;
  readonly now: Date;
  readonly cooldownUntil?: Date;
}

export interface WarmupPoolHealthSnapshot {
  readonly poolId: WarmupPoolId;
  readonly status: WarmupPoolStatus;
  readonly memberships: number;
  readonly eligibleEstimate: number;
  readonly membershipsByStatus: Readonly<Record<WarmupPoolMembershipStatus, number>>;
}

export interface WarmupPoolRepository {
  createPool(input: CreateWarmupPoolInput): Promise<WarmupPool>;
  listPools(tenantId: TenantId): Promise<WarmupPool[]>;
  getPool(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPool | undefined>;
  patchPool(tenantId: TenantId, poolId: WarmupPoolId, input: PatchWarmupPoolInput): Promise<WarmupPool | undefined>;
  addMembership(input: AddWarmupPoolMembershipInput): Promise<WarmupPoolMembership>;
  listMemberships(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolMembership[]>;
  findActivePoolForMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupPool | undefined>;
  getHealth(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolHealthSnapshot | undefined>;
  lockPoolAndCandidates(
    client: DatabaseClient,
    tenantId: TenantId,
    poolId: WarmupPoolId,
  ): Promise<{ pool: WarmupPool; candidates: WarmupPoolCandidate[] } | undefined>;
  applySelection(client: DatabaseClient, input: ApplySelectionInput): Promise<void>;
  noteIntentBoundToMailbox(tenantId: TenantId, mailboxId: MailboxId, now: Date): Promise<void>;
}

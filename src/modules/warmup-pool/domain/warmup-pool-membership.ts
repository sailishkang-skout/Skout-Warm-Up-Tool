import type { MailboxId, TenantId, WarmupPoolId, WarmupPoolMembershipId } from "../../../shared/types/index.js";

export const WARMUP_POOL_MEMBERSHIP_STATUSES = ["AVAILABLE", "ACTIVE", "COOLDOWN", "DRAINING", "DISABLED"] as const;
export type WarmupPoolMembershipStatus = (typeof WARMUP_POOL_MEMBERSHIP_STATUSES)[number];

export interface WarmupPoolMembership {
  readonly id: WarmupPoolMembershipId;
  readonly poolId: WarmupPoolId;
  readonly mailboxId: MailboxId;
  readonly tenantId: TenantId;
  readonly status: WarmupPoolMembershipStatus;
  readonly priority: number;
  readonly weight: number;
  readonly maxDailyWarmupVolume?: number;
  readonly currentDailyWarmupVolume: number;
  readonly usageDate: string;
  readonly lastSelectedAt?: Date;
  readonly cooldownUntil?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function effectiveDailyUsage(membership: Pick<WarmupPoolMembership, "usageDate" | "currentDailyWarmupVolume">, now: Date): number {
  return membership.usageDate === utcDateString(now) ? membership.currentDailyWarmupVolume : 0;
}

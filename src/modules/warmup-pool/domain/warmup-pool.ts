import type { MailboxId, TenantId, WarmupPoolId } from "../../../shared/types/index.js";

export const WARMUP_POOL_STATUSES = ["ACTIVE", "PAUSED", "DRAINING"] as const;
export type WarmupPoolStatus = (typeof WARMUP_POOL_STATUSES)[number];

export const WARMUP_POOL_STRATEGIES = [
  "ROUND_ROBIN",
  "LEAST_USED",
  "WEIGHTED",
  "HEALTH_FIRST",
  "HEALTH_FIRST_LEAST_USED",
] as const;
export type WarmupPoolStrategy = (typeof WARMUP_POOL_STRATEGIES)[number];

export interface WarmupPool {
  readonly id: WarmupPoolId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly status: WarmupPoolStatus;
  readonly strategy: WarmupPoolStrategy;
  readonly maxConsecutiveSameDomain: number;
  readonly maxDomainSharePercent: number;
  readonly lastSelectedMailboxId?: MailboxId;
  readonly lastSelectedDomain?: string;
  readonly consecutiveSameDomain: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function emailDomain(canonicalEmail: string): string {
  const at = canonicalEmail.lastIndexOf("@");
  return at >= 0 ? canonicalEmail.slice(at + 1) : canonicalEmail;
}

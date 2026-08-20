export const WARMUP_NETWORK_INFRA_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type WarmupNetworkInfraStatus = (typeof WARMUP_NETWORK_INFRA_STATUSES)[number];

export const WARMUP_NETWORK_ENTITY_STATUSES = ["ACTIVE", "DEGRADED", "COOLDOWN", "QUARANTINED", "DISABLED"] as const;
export type WarmupNetworkEntityStatus = (typeof WARMUP_NETWORK_ENTITY_STATUSES)[number];

export const WARMUP_NETWORK_PROVIDERS = ["GMAIL", "MICROSOFT365"] as const;
export type WarmupNetworkProvider = (typeof WARMUP_NETWORK_PROVIDERS)[number];

export const WARMUP_NETWORK_AUTH_STATUSES = ["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"] as const;
export type WarmupNetworkAuthStatus = (typeof WARMUP_NETWORK_AUTH_STATUSES)[number];

export const WARMUP_NETWORK_REPUTATION_STATUSES = [
  "EXCELLENT",
  "HEALTHY",
  "DEGRADED",
  "POOR",
  "CRITICAL",
  "UNKNOWN",
] as const;
export type WarmupNetworkReputationStatus = (typeof WARMUP_NETWORK_REPUTATION_STATUSES)[number];

export const WARMUP_NETWORK_CAPACITY_STATUSES = ["AVAILABLE", "EXHAUSTED"] as const;
export type WarmupNetworkCapacityStatus = (typeof WARMUP_NETWORK_CAPACITY_STATUSES)[number];

export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function effectiveUsageCount(usageDate: string, usageCount: number, now: Date): number {
  return usageDate === utcDateString(now) ? usageCount : 0;
}

export function remainingCapacity(dailyCapacity: number, usageDate: string, usageCount: number, now: Date): number {
  return Math.max(0, dailyCapacity - effectiveUsageCount(usageDate, usageCount, now));
}

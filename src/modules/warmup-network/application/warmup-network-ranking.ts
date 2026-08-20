import type { WarmupNetworkMailboxId } from "../../../shared/types/index.js";
import type { WarmupNetworkProvider } from "../domain/warmup-network-status.js";

export interface RankableWarmupMailbox {
  readonly id: WarmupNetworkMailboxId;
  readonly provider: WarmupNetworkProvider;
  readonly healthScore: number;
  readonly remainingCapacity: number;
}

export function applyRecentInteractionAvoidance<T extends { id: WarmupNetworkMailboxId }>(
  eligible: readonly T[],
  recentIds: ReadonlySet<string>,
): T[] {
  const preferred = eligible.filter((candidate) => !recentIds.has(candidate.id));
  return preferred.length > 0 ? [...preferred] : [...eligible];
}

export function compareWarmupMailboxCandidates(
  a: RankableWarmupMailbox,
  b: RankableWarmupMailbox,
  customerProvider: string,
): number {
  const aSame = a.provider === customerProvider ? 0 : 1;
  const bSame = b.provider === customerProvider ? 0 : 1;
  if (aSame !== bSame) {
    return aSame - bSame;
  }
  if (b.healthScore !== a.healthScore) {
    return b.healthScore - a.healthScore;
  }
  if (b.remainingCapacity !== a.remainingCapacity) {
    return b.remainingCapacity - a.remainingCapacity;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

export function selectRankedWarmupMailbox<T extends RankableWarmupMailbox>(
  candidates: readonly T[],
  customerProvider: string,
): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  return [...candidates].sort((a, b) => compareWarmupMailboxCandidates(a, b, customerProvider))[0];
}

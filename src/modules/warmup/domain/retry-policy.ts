import type { ProviderSendResult, ProviderSendStatus } from "./send-result.js";

/**
 * The fixed classification Stage 8 spec section 14 lists — the engine
 * decides retryability, not the provider adapter (section 9's "only the
 * warmup policy/engine decides" applies here too). A provider result's own
 * `retryable` flag is still consulted in `classifyRetry` below, but only as
 * an AND with this table, never on its own: a misbehaving/future provider
 * implementation claiming a `PERMANENT_FAILURE` is retryable can never
 * force an actual retry.
 */
const RETRYABLE_STATUSES: ReadonlySet<ProviderSendStatus> = new Set(["RATE_LIMITED", "TEMPORARY_FAILURE"]);

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly delayMs?: number;
  readonly reason: string;
}

/**
 * Bounded — Stage 8 spec section 14: "Do not retry indefinitely." Once
 * `attemptCount` reaches `MAX_ATTEMPTS` the intent is permanently FAILED
 * regardless of how retryable the underlying failure looked, so a
 * persistently-rate-limited mailbox can never retry forever.
 */
export function classifyRetry(result: ProviderSendResult, attemptCount: number, random: () => number = Math.random): RetryDecision {
  if (!RETRYABLE_STATUSES.has(result.status) || !result.retryable) {
    return { shouldRetry: false, reason: `status '${result.status}' is not retryable` };
  }
  if (attemptCount >= MAX_ATTEMPTS) {
    return { shouldRetry: false, reason: `maximum attempts (${MAX_ATTEMPTS}) reached` };
  }
  return { shouldRetry: true, delayMs: computeBackoffDelay(attemptCount, random), reason: "retryable failure, attempts remain" };
}

/**
 * Deterministic given `random` (Stage 8 spec section 15) — exponential,
 * capped at `MAX_DELAY_MS` so growth is bounded rather than unbounded, with
 * jitter confined to the second half of the capped window (`[cap/2, cap]`)
 * so it never collapses back toward zero delay while still preventing
 * synchronized retries across many mailboxes failing at once.
 */
export function computeBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = BASE_DELAY_MS * 2 ** attempt;
  const cap = Math.min(exponential, MAX_DELAY_MS);
  return Math.round(cap / 2 + (cap / 2) * random());
}

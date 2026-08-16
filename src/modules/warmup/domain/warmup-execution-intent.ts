import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type {
  MailboxId,
  TenantId,
  WarmupDecisionId,
  WarmupExecutionIntentId,
  WarmupSessionId,
} from "../../../shared/types/index.js";
import type { ProviderSendResult } from "./send-result.js";

/**
 * A decision (`WarmupDecision`) says "what should happen"; an execution
 * intent is the separate, persisted record of "this specific attempt is
 * about to happen" (Stage 8 spec section 11) — the thing a worker claims
 * and a provider send boundary eventually acts on. Creating an intent is
 * never itself a send.
 */
export const EXECUTION_INTENT_STATUSES = [
  "PENDING",
  "CLAIMED",
  "SENDING",
  "SENT",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  /**
   * The provider's actual receipt could not be confirmed (Stage 9 spec
   * section 7 — see `send-result.ts`'s `SEND_UNKNOWN`). Terminal, like
   * `FAILED`, but deliberately distinct: `claimNext` only ever selects
   * `PENDING` rows, so an intent that lands here is never automatically
   * retried or reclaimed — it requires manual reconciliation (checking the
   * mailbox's actual sent history) before anyone decides what happened.
   */
  "SEND_UNKNOWN",
] as const;
export type ExecutionIntentStatus = (typeof EXECUTION_INTENT_STATUSES)[number];

/**
 * `idempotencyKey` is deterministic from `tenantId`/`sessionId`/`warmupDay`/
 * `executionSlot` (Stage 8 spec section 12 — see
 * `application/idempotency.ts`) and is the column PostgreSQL enforces
 * uniqueness on; `warmupDay`/`executionSlot` are kept alongside it purely
 * for readability/querying, never re-derived from the key string.
 *
 * `leaseOwner`/`leaseExpiresAt`/`attemptCount` back the claim model (Stage
 * 8 spec section 13) — a worker only ever transitions PENDING → CLAIMED by
 * atomically taking the lease (see
 * `infrastructure/postgres-warmup-execution-intent-repository.ts`).
 */
export interface WarmupExecutionIntent {
  readonly id: WarmupExecutionIntentId;
  readonly tenantId: TenantId;
  readonly sessionId: WarmupSessionId;
  readonly mailboxId: MailboxId;
  readonly decisionId: WarmupDecisionId;
  readonly provider: MailboxProviderType;
  readonly warmupDay: number;
  readonly executionSlot: number;
  readonly idempotencyKey: string;
  readonly volume: number;
  readonly scheduledFor?: Date;
  readonly status: ExecutionIntentStatus;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: Date;
  readonly attemptCount: number;
  readonly lastResult?: ProviderSendResult;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IdempotencyKeyInput {
  readonly tenantId: TenantId;
  readonly sessionId: WarmupSessionId;
  readonly warmupDay: number;
  readonly executionSlot: number;
}

/**
 * Deterministic and side-effect-free — the same inputs always produce the
 * same key (Stage 8 spec section 12's conceptual form:
 * `tenant + session + warmupDay + executionSlot`). Delimited rather than
 * hashed: branded ids are already opaque UUID-shaped strings, so a
 * readable, debuggable key costs nothing and a hash would only make
 * support/debugging harder for no real benefit.
 */
export function computeIdempotencyKey(input: IdempotencyKeyInput): string {
  return `${input.tenantId}:${input.sessionId}:${input.warmupDay}:${input.executionSlot}`;
}

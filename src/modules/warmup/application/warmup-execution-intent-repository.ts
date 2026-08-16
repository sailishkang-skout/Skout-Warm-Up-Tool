import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type {
  MailboxId,
  TenantId,
  WarmupDecisionId,
  WarmupExecutionIntentId,
  WarmupSessionId,
} from "../../../shared/types/index.js";
import type { ExecutionIntentStatus, WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import type { ProviderSendResult } from "../domain/send-result.js";

export interface CreateExecutionIntentInput {
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
  readonly expiresAt: Date;
}

export interface RecordExecutionResultInput {
  readonly status: ExecutionIntentStatus;
  readonly result: ProviderSendResult;
  /** Set only when re-queuing a retryable failure — moves `status` back to PENDING with a future `scheduledFor`. */
  readonly scheduledFor?: Date;
}

/**
 * Port implemented by
 * `infrastructure/postgres-warmup-execution-intent-repository.ts`.
 * `claimNext` is deliberately not tenant-scoped — a worker is a background
 * process claiming across all tenants (the same shape as this service's
 * other genuinely cross-tenant infrastructure, e.g. `domain-intelligence`'s
 * cache); every method after a claim always re-checks `tenantId` against
 * the claimed intent's own, so no cross-tenant data ever flows through a
 * caller mistake.
 */
export interface WarmupExecutionIntentRepository {
  /** Idempotent — Stage 8 spec section 12: a duplicate `idempotencyKey` returns the existing row rather than erroring or inserting a second one. */
  createIfAbsent(input: CreateExecutionIntentInput): Promise<WarmupExecutionIntent>;
  findById(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<WarmupExecutionIntent | undefined>;
  /**
   * Atomically claims one eligible (`PENDING`, not expired, `scheduledFor`
   * due) intent and sets it `CLAIMED` with the given lease (Stage 8 spec
   * section 13) — uses `FOR UPDATE SKIP LOCKED` under the hood so two
   * concurrent workers never claim the same row. Returns `undefined` if
   * nothing is currently claimable.
   */
  claimNext(leaseOwner: string, leaseDurationMs: number): Promise<WarmupExecutionIntent | undefined>;
  /** CLAIMED → SENDING. Throws `ConflictError` if `leaseOwner` no longer matches (lease expired/reassigned). */
  markSending(tenantId: TenantId, intentId: WarmupExecutionIntentId, leaseOwner: string): Promise<WarmupExecutionIntent>;
  /** Records the outcome of one attempt — terminal (`SENT`/`FAILED`/`CANCELLED`/`EXPIRED`) or re-queued (`PENDING` with a new `scheduledFor`). Throws `ConflictError` if `leaseOwner` no longer matches. */
  recordResult(
    tenantId: TenantId,
    intentId: WarmupExecutionIntentId,
    leaseOwner: string,
    input: RecordExecutionResultInput,
  ): Promise<WarmupExecutionIntent>;
  /**
   * `SEND_UNKNOWN` → `REQUIRES_RECONCILIATION` (hardening spec Gap A) — not
   * lease-gated like `recordResult`, since reconciliation is requested by
   * an operator/API call, not a worker holding a claim. Idempotent by
   * design: calling this again on an intent already `REQUIRES_RECONCILIATION`
   * returns that same row unchanged rather than erroring, so a duplicate
   * reconciliation request is always safe. Throws `ConflictError` if the
   * intent exists but is in neither status (e.g. already `SENT`/`FAILED` —
   * reconciliation only ever applies to an unconfirmed send).
   */
  markRequiresReconciliation(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<WarmupExecutionIntent>;
}

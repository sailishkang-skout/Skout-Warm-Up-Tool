import type { MailboxId, TenantId, WarmupProfileId, WarmupSessionId } from "../../../shared/types/index.js";
import type { WarmupState } from "./warmup-state.js";

/**
 * The warmup lifecycle aggregate — Stage 8 spec section 4. Deliberately
 * does not duplicate mailbox health/risk/eligibility: those are always
 * read fresh from `health`/`risk`/`policy` at decision time (see
 * `application/warmup-execution-policy.ts`), never cached on this record.
 *
 * `currentDay`/`currentDailyTarget`/`committedVolumeToday`/`nextExecutionSlot`
 * are the per-warmup-day counters the ramp/idempotency model depends on —
 * see `domain/warmup-day.ts` for how "day" is computed and
 * `infrastructure/postgres-warmup-session-repository.ts` for how they're
 * atomically reset when the day advances.
 */
export interface WarmupSession {
  readonly id: WarmupSessionId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly profileId: WarmupProfileId;
  readonly state: WarmupState;
  readonly startedAt?: Date;
  readonly pausedAt?: Date;
  readonly completedAt?: Date;
  readonly stoppedAt?: Date;
  readonly currentDay: number;
  readonly currentDailyTarget: number;
  /** Volume already committed to execution intents for `currentDay` — see warmup-execution-intent.ts's idempotency model. */
  readonly committedVolumeToday: number;
  /** Next unused execution-slot index for `currentDay`, atomically allocated. */
  readonly nextExecutionSlot: number;
  readonly lastDecisionAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

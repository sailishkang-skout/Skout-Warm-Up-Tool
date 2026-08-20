import type { MailboxId, TenantId, WarmupProfileId, WarmupSessionId } from "../../../shared/types/index.js";
import type { WarmupSession } from "../domain/warmup-session.js";
import type { WarmupState } from "../domain/warmup-state.js";

export interface CreateWarmupSessionInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly profileId: WarmupProfileId;
}

/**
 * Port implemented by `infrastructure/postgres-warmup-session-repository.ts`.
 * Every mutating method here is a single atomic statement, never a
 * read-then-write pair in application code — the "one active session" and
 * "daily volume never exceeds the target" invariants (Stage 8 spec sections
 * 5/25) both depend on that.
 */
export interface WarmupSessionRepository {
  /** Created in `DRAFT`. Throws `ConflictError` if the mailbox already has an open (non-terminal) session — see migrations/013's partial unique index, the actual source of truth under concurrency. */
  create(input: CreateWarmupSessionInput): Promise<WarmupSession>;
  findById(tenantId: TenantId, sessionId: WarmupSessionId): Promise<WarmupSession | undefined>;
  /** The mailbox's current non-terminal session (DRAFT/ACTIVE/PAUSED/COOLDOWN/FAILED), if any — undefined once COMPLETED/STOPPED. */
  findOpenByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession | undefined>;
  /** The mailbox's most recently created session regardless of state — used for status/decision-history reads so a STOPPED/COMPLETED session's history remains visible (Stage 8 spec section 22). */
  findLatestByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession | undefined>;
  /**
   * Atomic compare-and-swap: succeeds only if the session's current state
   * still equals `fromState` at write time. Throws `ConflictError` if it
   * has already moved (a concurrent pause/resume/stop won the race) and
   * `NotFoundError` if the session doesn't exist for this tenant.
   */
  transitionState(tenantId: TenantId, sessionId: WarmupSessionId, fromState: WarmupState, toState: WarmupState): Promise<WarmupSession>;
  /**
   * Records the outcome of a fresh daily-decision computation. A single
   * atomic UPDATE: if `day` is newer than the session's stored day, the
   * per-day counters (`committedVolumeToday`/`nextExecutionSlot`) reset to
   * zero in the same statement; if `day` matches, only the target updates.
   * Guarded so `day` can never move backwards.
   */
  recordDailyDecision(tenantId: TenantId, sessionId: WarmupSessionId, day: number, dailyTarget: number): Promise<WarmupSession>;
  /**
   * Atomically reserves the next execution slot and reserves `volume`
   * against `currentDailyTarget` for `day` in one statement (Stage 8 spec
   * section 25/26) — returns `undefined` if `day` no longer matches the
   * session's current day, or if committing `volume` would exceed
   * `currentDailyTarget`. Never a separate check-then-write.
   */
  commitExecutionVolume(
    tenantId: TenantId,
    sessionId: WarmupSessionId,
    day: number,
    volume: number,
  ): Promise<{ readonly session: WarmupSession; readonly allocatedSlot: number } | undefined>;
  /**
   * Cross-tenant background-scan candidates (Stage 12) — deliberately not
   * tenant-scoped, same reasoning `WarmupExecutionIntentRepository.claimNext`
   * already establishes: a scheduler is a background process considering
   * every tenant's due work, not one tenant's. `last_decision_at < today's
   * UTC midnight` is a cheap, correct-enough pre-filter (any session whose
   * last decision predates today is a candidate); the caller
   * (`application/warmup-scheduler.ts`) still re-derives the authoritative
   * "is it actually due" answer via `domain/warmup-day.ts`'s
   * `computeWarmupDay` per candidate before acting — this method never
   * duplicates that domain calculation in SQL.
   */
  findActiveSessionsDueForDecision(beforeUtcMidnight: Date, limit: number): Promise<WarmupSession[]>;
}

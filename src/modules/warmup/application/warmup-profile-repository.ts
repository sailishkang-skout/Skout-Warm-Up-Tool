import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { RampStrategy, RiskTolerance, WarmupProfile } from "../domain/warmup-profile.js";

export interface CreateWarmupProfileInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly targetDailyVolume: number;
  readonly startingDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly rampStrategy: RampStrategy;
  readonly riskTolerance: RiskTolerance;
  readonly pauseConditions?: readonly string[];
}

/**
 * Every field optional (partial update) — deliberately excludes `active`.
 * Stage 9 spec section 12: "Do not expose `active` as a freely mutable
 * profile field" — `setActive` below remains the only way it ever changes,
 * and only `WarmupService` ever calls it.
 */
export interface UpdateWarmupProfileInput {
  readonly targetDailyVolume?: number;
  readonly startingDailyVolume?: number;
  readonly maximumDailyVolume?: number;
  readonly rampStrategy?: RampStrategy;
  readonly riskTolerance?: RiskTolerance;
  readonly pauseConditions?: readonly string[];
}

/** Port implemented by `infrastructure/postgres-warmup-profile-repository.ts`. One profile per mailbox (warmup_profiles_mailbox_unique). */
export interface WarmupProfileRepository {
  create(input: CreateWarmupProfileInput): Promise<WarmupProfile>;
  findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupProfile | undefined>;
  /** Partial update of the mutable configuration fields only — never `active`. Throws `NotFoundError` if no profile exists for this mailbox. */
  update(tenantId: TenantId, mailboxId: MailboxId, input: UpdateWarmupProfileInput): Promise<WarmupProfile>;
  /**
   * Stage 7 deliberately left every profile `active: false` at creation —
   * "a profile existing is never itself what starts sending." Stage 8's
   * `WarmupService` is the first thing with a reason to flip it: starting a
   * warmup session (`active: true`) and stopping one (`active: false`) are
   * the only two call sites (`application/warmup-service.ts`) — no generic
   * profile-editing endpoint exists yet.
   */
  setActive(tenantId: TenantId, mailboxId: MailboxId, active: boolean): Promise<WarmupProfile>;
}

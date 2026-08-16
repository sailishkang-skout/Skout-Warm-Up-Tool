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

/** Port implemented by `infrastructure/postgres-warmup-profile-repository.ts`. One profile per mailbox (warmup_profiles_mailbox_unique). */
export interface WarmupProfileRepository {
  create(input: CreateWarmupProfileInput): Promise<WarmupProfile>;
  findByMailboxId(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupProfile | undefined>;
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

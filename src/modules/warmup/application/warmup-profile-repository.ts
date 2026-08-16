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
}

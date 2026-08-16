import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { ConflictError, ValidationError } from "../../../shared/errors/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { RampStrategy, RiskTolerance, WarmupProfile } from "../domain/warmup-profile.js";
import type { UpdateWarmupProfileInput, WarmupProfileRepository } from "./warmup-profile-repository.js";

export interface WarmupProfileConfigValues {
  readonly targetDailyVolume: number;
  readonly startingDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly rampStrategy: RampStrategy;
  readonly riskTolerance: RiskTolerance;
  readonly pauseConditions?: readonly string[];
}

export interface WarmupProfileService {
  /** Ownership-checked (throws `NotFoundError` for the wrong tenant) even when no profile exists yet. */
  getProfile(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupProfile | undefined>;
  /** Throws `ConflictError` if a profile already exists for this mailbox. */
  createProfile(tenantId: TenantId, mailboxId: MailboxId, input: WarmupProfileConfigValues): Promise<WarmupProfile>;
  /** Partial update — never `active` (Stage 9 spec section 12; see `WarmupService.startWarmup`/`stopWarmup` for the only place that changes). */
  updateProfile(tenantId: TenantId, mailboxId: MailboxId, input: UpdateWarmupProfileInput): Promise<WarmupProfile>;
}

export interface CreateWarmupProfileServiceDeps {
  readonly mailboxService: MailboxService;
  readonly warmupProfileRepository: WarmupProfileRepository;
}

/**
 * Configuration bounds beyond what the database's own CHECK constraints
 * enforce (Stage 9 spec section 12: "Validate: ramp strategy, maximum
 * daily volume, risk tolerance, configuration bounds") — a clean
 * `ValidationError` here is a better experience than a raw constraint
 * violation, and this specific ordering invariant
 * (starting <= target <= maximum) has no database constraint at all.
 */
function assertValidBounds(values: { startingDailyVolume: number; targetDailyVolume: number; maximumDailyVolume: number }): void {
  if (values.startingDailyVolume > values.targetDailyVolume) {
    throw new ValidationError("startingDailyVolume must not exceed targetDailyVolume");
  }
  if (values.targetDailyVolume > values.maximumDailyVolume) {
    throw new ValidationError("targetDailyVolume must not exceed maximumDailyVolume");
  }
}

export function createWarmupProfileService(deps: CreateWarmupProfileServiceDeps): WarmupProfileService {
  const { mailboxService, warmupProfileRepository } = deps;

  return {
    async getProfile(tenantId, mailboxId) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      return warmupProfileRepository.findByMailboxId(tenantId, mailboxId);
    },

    async createProfile(tenantId, mailboxId, input) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      assertValidBounds(input);

      const existing = await warmupProfileRepository.findByMailboxId(tenantId, mailboxId);
      if (existing) {
        throw new ConflictError("A warmup profile already exists for this mailbox");
      }

      return warmupProfileRepository.create({
        tenantId,
        mailboxId,
        targetDailyVolume: input.targetDailyVolume,
        startingDailyVolume: input.startingDailyVolume,
        maximumDailyVolume: input.maximumDailyVolume,
        rampStrategy: input.rampStrategy,
        riskTolerance: input.riskTolerance,
        ...(input.pauseConditions ? { pauseConditions: input.pauseConditions } : {}),
      });
    },

    async updateProfile(tenantId, mailboxId, input) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      const current = await warmupProfileRepository.findByMailboxId(tenantId, mailboxId);
      if (!current) {
        throw new ConflictError("No warmup profile exists yet for this mailbox — create one first");
      }

      assertValidBounds({
        startingDailyVolume: input.startingDailyVolume ?? current.startingDailyVolume,
        targetDailyVolume: input.targetDailyVolume ?? current.targetDailyVolume,
        maximumDailyVolume: input.maximumDailyVolume ?? current.maximumDailyVolume,
      });

      return warmupProfileRepository.update(tenantId, mailboxId, input);
    },
  };
}

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
  /** Minutes since local midnight (0-1439), evaluated against the mailbox's own timezone — both present or both absent (Stage 12). */
  readonly windowStartMinute?: number;
  readonly windowEndMinute?: number;
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

const MINUTES_PER_DAY = 1440;

/**
 * Both-or-neither, each in `[0, 1439]` (Stage 12). Equal start/end is
 * accepted (a deliberate "never send" configuration — see
 * `domain/send-window.ts`); `windowEndMinute <= windowStartMinute` is a
 * valid overnight window, not an error, so no ordering check here beyond
 * range bounds.
 */
function assertValidWindow(values: { windowStartMinute?: number; windowEndMinute?: number }): void {
  const { windowStartMinute, windowEndMinute } = values;
  if ((windowStartMinute === undefined) !== (windowEndMinute === undefined)) {
    throw new ValidationError("windowStartMinute and windowEndMinute must be set together, or not at all");
  }
  for (const [name, value] of [
    ["windowStartMinute", windowStartMinute],
    ["windowEndMinute", windowEndMinute],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value >= MINUTES_PER_DAY)) {
      throw new ValidationError(`${name} must be an integer between 0 and ${MINUTES_PER_DAY - 1}`);
    }
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
      assertValidWindow(input);

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
        ...(input.windowStartMinute !== undefined ? { windowStartMinute: input.windowStartMinute, windowEndMinute: input.windowEndMinute } : {}),
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
      assertValidWindow(input);

      return warmupProfileRepository.update(tenantId, mailboxId, input);
    },
  };
}

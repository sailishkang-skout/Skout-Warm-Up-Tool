import type { MailboxId, TenantId, WarmupProfileId } from "../../../shared/types/index.js";

export const RAMP_STRATEGIES = ["CONSERVATIVE", "STANDARD", "AGGRESSIVE"] as const;
export type RampStrategy = (typeof RAMP_STRATEGIES)[number];

export const RISK_TOLERANCES = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskTolerance = (typeof RISK_TOLERANCES)[number];

/**
 * Configuration and intelligence inputs for a future warmup engine —
 * deliberately not scheduling state. There is no send history, no cadence
 * engine, no job queue here (Stage 7 spec section 12: "Do NOT implement
 * actual scheduling yet"). `active` defaults to `false` at creation
 * (migrations/012_create_warmup_profiles.sql) so a profile existing is
 * never itself what starts sending.
 *
 * `pauseConditions` holds stable, machine-readable codes (e.g.
 * `"RISK_CRITICAL"`, `"PROVIDER_DISCONNECTED"`) a future engine would check
 * before sending — not implemented here, just the declared configuration
 * surface for it.
 */
export interface WarmupProfile {
  readonly id: WarmupProfileId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly targetDailyVolume: number;
  readonly startingDailyVolume: number;
  readonly maximumDailyVolume: number;
  readonly rampStrategy: RampStrategy;
  readonly riskTolerance: RiskTolerance;
  readonly active: boolean;
  readonly pauseConditions: readonly string[];
  /**
   * Minutes since local midnight (0-1439), evaluated against the
   * mailbox's own `timezone` (Stage 12 — see `domain/send-window.ts`).
   * Both present or both absent: unconfigured means no window
   * restriction, preserving exactly the pre-Stage-12 behavior (a mailbox
   * is eligible to send at any time) rather than forcing every existing
   * profile into a default window nobody configured.
   */
  readonly windowStartMinute?: number;
  readonly windowEndMinute?: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

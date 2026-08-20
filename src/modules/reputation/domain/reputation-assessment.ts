import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { DnsCheckStatus } from "../../domain-intelligence/domain/domain-authentication.js";
import type { MailboxId, ReputationAssessmentId, TenantId } from "../../../shared/types/index.js";

export const REPUTATION_STATUSES = ["EXCELLENT", "HEALTHY", "DEGRADED", "POOR", "CRITICAL", "UNKNOWN"] as const;
export type ReputationStatus = (typeof REPUTATION_STATUSES)[number];

export const TREND_DIRECTIONS = ["IMPROVING", "STABLE", "DEGRADING", "UNKNOWN"] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

/**
 * Deliberately a fresh, local severity type rather than importing `risk`'s
 * `RiskLevel` — same reasoning `warmup`'s `ProviderSendResult` deliberately
 * duplicates `providers`' `ProviderSendOutcome` vocabulary rather than
 * importing it backward (see `warmup/domain/send-result.ts`): the
 * dependency direction is `reputation → risk` (risk consumes reputation
 * factors, never the reverse), so reputation cannot import risk's types
 * without inverting it.
 */
export const REPUTATION_FACTOR_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ReputationFactorSeverity = (typeof REPUTATION_FACTOR_SEVERITIES)[number];

/** `code` is a stable, machine-readable identifier `risk` maps to its own risk factors; `description` is safe/human-readable — never a raw provider payload. */
export interface ReputationFactor {
  readonly code: string;
  readonly description: string;
  readonly severity: ReputationFactorSeverity;
}

export interface ReputationTrends {
  readonly delivery: TrendDirection;
  readonly bounce: TrendDirection;
  readonly throttle: TrendDirection;
  readonly failure: TrendDirection;
  readonly complaint: TrendDirection;
}

/**
 * A rate is `"UNKNOWN"`, never a fabricated `0`, whenever the window's
 * event count is below `MIN_SAMPLE_SIZE_FOR_RATE` (Stage 10 spec section
 * 6/23: "No complaint data available ≠ 0 complaints"). Every rate is
 * `count / eventCount`, 0-1, computed only once there is enough evidence
 * to mean something.
 */
export type Rate = number | "UNKNOWN";

export interface ReputationWindowEvidence {
  readonly eventCount: number;
  readonly deliveryRate: Rate;
  readonly bounceRate: Rate;
  readonly hardBounceRate: Rate;
  readonly softBounceRate: Rate;
  readonly throttleRate: Rate;
  readonly rejectionRate: Rate;
  readonly failureRate: Rate;
  readonly complaintRate: Rate;
  readonly unknownRate: Rate;
}

/**
 * The shared shape of one aggregated reputation view — reused as-is for the
 * mailbox itself (the top-level `ReputationAssessment` fields below) and,
 * as of Stage 11, for the provider- and domain-scoped views embedded in it.
 * All three are produced by the exact same
 * `application/reputation-policy.ts#evaluateReputation` function — only the
 * `DeliveryEventCounts` fed into it (mailbox-scoped vs. tenant+provider-
 * scoped vs. tenant+domain-scoped) differs, never the evaluation logic
 * itself (Stage 11 spec: "do not create a second reputation engine").
 */
interface ReputationView {
  readonly status: ReputationStatus;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly factors: readonly ReputationFactor[];
  readonly trends: ReputationTrends;
  readonly last24h: ReputationWindowEvidence;
  readonly last7d: ReputationWindowEvidence;
  readonly lifetime: ReputationWindowEvidence;
}

/**
 * Aggregates delivery-event evidence across every mailbox this tenant sends
 * through the given provider (Stage 11 spec section 2) — never across
 * tenants (tenant isolation is enforced at the query level, see
 * `delivery-events/infrastructure/postgres-delivery-event-repository.ts`'s
 * `countByEventTypeForProvider`). `factors` use codes prefixed `PROVIDER_`
 * (e.g. `PROVIDER_HIGH_BOUNCE_RATE`) so they can never be confused with the
 * mailbox-scoped codes above once both flow into `risk` — see
 * `risk/application/risk-policy.ts`. Evidence-driven only: with too few
 * provider-wide events, every rate and `status` here is `"UNKNOWN"`, never a
 * fabricated `GOOD`/`SAFE` (Stage 11 spec section 2).
 */
export interface ProviderReputationSnapshot extends ReputationView {
  readonly provider: MailboxProviderType;
}

/** Safe subset of `domain-intelligence`'s `DomainAuthenticationAssessment` — status enums only, never a raw DNS record string. */
export interface DomainAuthenticationSummary {
  readonly mx: DnsCheckStatus;
  readonly spf: DnsCheckStatus;
  readonly dkim: DnsCheckStatus;
  readonly dmarc: DnsCheckStatus;
}

/**
 * Aggregates delivery-event evidence across every mailbox this tenant sends
 * through the given sending domain (Stage 11 spec section 3), plus
 * `authentication` — reused directly from `domain-intelligence`, never
 * recomputed here (Stage 11 spec: "do not duplicate DNS checks"). `factors`
 * use codes prefixed `DOMAIN_`. Domain auth facts (MX/SPF/DMARC) already
 * flow into `risk` independently via `health.domain` — `authentication`
 * here is for visibility only and is never itself re-fed into `risk`
 * factors, which would double-count the same evidence; only the
 * delivery-event-driven `factors` (genuinely new evidence) are.
 */
export interface DomainReputationSnapshot extends ReputationView {
  readonly domain: string;
  readonly authentication: DomainAuthenticationSummary;
}

/**
 * The deterministic, persisted output of `application/reputation-policy.ts`
 * (Stage 10 spec section 9) — mailbox-level, evidence-derived, and
 * explicitly NOT a replacement for `risk`'s own `RiskAssessment`: this
 * feeds `risk` as an additional input (`application/risk-policy.ts`'s
 * `RiskPolicyInput.reputation`), it never decides risk or warmup volume
 * itself (Stage 10 spec section 9/16 — "the risk engine remains
 * authoritative"). Append-only history via
 * `infrastructure/postgres-reputation-repository.ts` — see
 * migrations/019_create_reputation_assessments.sql.
 *
 * `providerReputation`/`domainReputation` (Stage 11) are computed in the
 * same assessment cycle and embedded in the same row rather than a second
 * table — from a consumer's perspective they are the same fact ("reputation
 * evidence available when this mailbox was assessed"), and embedding them
 * gives them the same append-only history/tenant-isolation/API for free
 * (see migrations/020_add_provider_domain_reputation.sql).
 */
export interface ReputationAssessment extends ReputationView {
  readonly id: ReputationAssessmentId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly providerReputation: ProviderReputationSnapshot;
  readonly domainReputation: DomainReputationSnapshot;
  readonly assessedAt: Date;
  readonly createdAt: Date;
}

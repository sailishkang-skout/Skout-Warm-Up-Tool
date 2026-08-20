import type { DeliveryEventCounts } from "../../delivery-events/application/delivery-event-repository.js";
import type {
  Rate,
  ReputationFactor,
  ReputationFactorSeverity,
  ReputationStatus,
  ReputationTrends,
  ReputationWindowEvidence,
  TrendDirection,
} from "../domain/reputation-assessment.js";

/**
 * Fewer events than this in a window and every rate in it is `"UNKNOWN"`,
 * never a fabricated `0` (Stage 10 spec section 6/23) — a window with 1
 * bounce out of 2 events is not meaningfully "50% bounce rate."
 */
const MIN_SAMPLE_SIZE_FOR_RATE = 5;
/** Both the recent and prior window need at least this many events before a trend is anything but `"UNKNOWN"` — never derived from one isolated event (Stage 10 spec section 8). */
const MIN_SAMPLE_SIZE_FOR_TREND = 5;
/** Absolute percentage-point shift between recent and prior windows to call it a trend rather than noise. */
const TREND_DELTA = 0.1;

/**
 * Deliberately NOT the generic bulk-sender percentages real providers
 * publish (e.g. Gmail's ~0.3% complaint guidance) — this system's warmup
 * volumes are tiny (a profile can start at ~5/day), where those
 * percentages would make a single event look catastrophic. Calibrated
 * instead for the scale this system actually operates at. Explicit and
 * configurable (Stage 10 spec section 10/13), not buried in a controller.
 */
const BOUNCE_RATE_THRESHOLDS = { degraded: 0.1, poor: 0.2, critical: 0.35 };
const THROTTLE_RATE_THRESHOLDS = { degraded: 0.15, poor: 0.3, critical: 0.5 };
const REJECTION_RATE_THRESHOLDS = { degraded: 0.1, poor: 0.25, critical: 0.4 };
const FAILURE_RATE_THRESHOLDS = { degraded: 0.1, poor: 0.25, critical: 0.4 };

/**
 * Complaints are gated by absolute count, not rate — at this system's
 * volumes a single complaint is meaningful but must never alone reach
 * `CRITICAL` (Stage 10 spec section 10: "Do not allow one noisy event to
 * produce CRITICAL risk").
 */
const COMPLAINT_COUNT_THRESHOLDS = { degraded: 1, poor: 3, critical: 6 };

const EXCELLENT_DELIVERY_RATE = 0.98;
const EXCELLENT_MIN_SAMPLE = 20;

export interface ReputationPolicyInput {
  readonly last24h: DeliveryEventCounts;
  readonly prior24h: DeliveryEventCounts;
  readonly last7d: DeliveryEventCounts;
  readonly lifetime: DeliveryEventCounts;
}

/**
 * Stage 11: lets `reputation-service.ts` reuse this exact function for
 * provider- and domain-scoped aggregation (`codePrefix: "PROVIDER_"` /
 * `"DOMAIN_"`) instead of duplicating the threshold/trend/status logic — the
 * only thing that differs between mailbox/provider/domain scope is which
 * `DeliveryEventCounts` are fed in, never the evaluation itself. Omitting it
 * (every pre-Stage-11 caller) produces byte-identical factor codes to
 * before.
 */
export interface EvaluateReputationOptions {
  readonly codePrefix?: string;
}

export interface ReputationPolicyResult {
  readonly status: ReputationStatus;
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly factors: readonly ReputationFactor[];
  readonly trends: ReputationTrends;
  readonly last24h: ReputationWindowEvidence;
  readonly last7d: ReputationWindowEvidence;
  readonly lifetime: ReputationWindowEvidence;
}

function eventCountOf(counts: DeliveryEventCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function rate(count: number, total: number): Rate {
  return total >= MIN_SAMPLE_SIZE_FOR_RATE ? count / total : "UNKNOWN";
}

/**
 * `hardBounceRate` is always `"UNKNOWN"` in this implementation — the
 * normalized `DeliveryEventType` taxonomy has one combined `BOUNCED` type,
 * not a hard/soft split (Stage 10 spec section 23: never fabricate a
 * distinction the evidence doesn't actually carry). `softBounceRate` uses
 * `DEFERRED` as its proxy — "temporarily undeliverable, try again" is
 * exactly what a soft bounce means.
 */
function computeWindowEvidence(counts: DeliveryEventCounts): ReputationWindowEvidence {
  const eventCount = eventCountOf(counts);
  return {
    eventCount,
    deliveryRate: rate(counts.DELIVERED, eventCount),
    bounceRate: rate(counts.BOUNCED, eventCount),
    hardBounceRate: "UNKNOWN",
    softBounceRate: rate(counts.DEFERRED, eventCount),
    throttleRate: rate(counts.THROTTLED, eventCount),
    rejectionRate: rate(counts.REJECTED, eventCount),
    failureRate: rate(counts.FAILED, eventCount),
    complaintRate: rate(counts.COMPLAINT, eventCount),
    unknownRate: rate(counts.UNKNOWN, eventCount),
  };
}

/**
 * `higherIsWorse` covers every metric here (bounce/throttle/failure/
 * complaint going up is bad; delivery going up is good — `higherIsWorse:
 * false` for delivery flips the comparison). Requires both sides to have
 * enough sample size, never a trend from one isolated event.
 */
function detectTrend(recent: Rate, prior: Rate, higherIsWorse: boolean): TrendDirection {
  if (recent === "UNKNOWN" || prior === "UNKNOWN") {
    return "UNKNOWN";
  }
  const delta = recent - prior;
  if (Math.abs(delta) < TREND_DELTA) {
    return "STABLE";
  }
  const worsened = higherIsWorse ? delta > 0 : delta < 0;
  return worsened ? "DEGRADING" : "IMPROVING";
}

function severityForThreshold(value: number, thresholds: { degraded: number; poor: number; critical: number }): ReputationFactorSeverity | undefined {
  if (value >= thresholds.critical) return "CRITICAL";
  if (value >= thresholds.poor) return "HIGH";
  if (value >= thresholds.degraded) return "MEDIUM";
  return undefined;
}

function pushRateFactor(
  factors: ReputationFactor[],
  rateValue: Rate,
  thresholds: { degraded: number; poor: number; critical: number },
  code: string,
  describe: (severity: ReputationFactorSeverity) => string,
): void {
  if (rateValue === "UNKNOWN") return;
  const severity = severityForThreshold(rateValue, thresholds);
  if (severity) {
    factors.push({ code, description: describe(severity), severity });
  }
}

function severityForCount(count: number, thresholds: { degraded: number; poor: number; critical: number }): ReputationFactorSeverity | undefined {
  if (count >= thresholds.critical) return "CRITICAL";
  if (count >= thresholds.poor) return "HIGH";
  if (count >= thresholds.degraded) return "MEDIUM";
  return undefined;
}

/**
 * A genuine triggered factor (e.g. a real complaint, gated by absolute
 * count rather than a rate — see `pushRateFactor` vs the complaint-count
 * check above) always takes priority over the "not enough evidence yet"
 * gate, no matter how small the lifetime sample is: real evidence is real
 * evidence, and `UNKNOWN` must never suppress it (Stage 10 spec section
 * 23: "never turn missing evidence into negative evidence" cuts both
 * ways — it also means never discarding evidence that *does* exist).
 * `UNKNOWN` is reserved for "nothing concerning triggered, and there also
 * isn't yet enough history to call this mailbox healthy."
 */
function statusFromFactors(factors: readonly ReputationFactor[], lifetime: ReputationWindowEvidence, last7d: ReputationWindowEvidence): ReputationStatus {
  const worst = factors.reduce<ReputationFactorSeverity | undefined>((current, f) => {
    const order: readonly ReputationFactorSeverity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
    if (!current || order.indexOf(f.severity) > order.indexOf(current)) return f.severity;
    return current;
  }, undefined);

  if (worst === "CRITICAL") return "CRITICAL";
  if (worst === "HIGH") return "POOR";
  if (worst === "MEDIUM") return "DEGRADED";

  if (lifetime.eventCount < MIN_SAMPLE_SIZE_FOR_RATE) {
    return "UNKNOWN";
  }
  if (last7d.deliveryRate !== "UNKNOWN" && last7d.deliveryRate >= EXCELLENT_DELIVERY_RATE && last7d.eventCount >= EXCELLENT_MIN_SAMPLE) {
    return "EXCELLENT";
  }
  return "HEALTHY";
}

function confidenceFromSampleSize(eventCount: number): "LOW" | "MEDIUM" | "HIGH" {
  if (eventCount < 10) return "LOW";
  if (eventCount < 50) return "MEDIUM";
  return "HIGH";
}

/**
 * Pure and deterministic — the same counts always produce the same
 * assessment, no clock reads, no I/O (matching every other policy function
 * in this codebase). `prior24h` is used only for trend detection, never
 * exposed as one of the three reported windows (Stage 10 spec section 7's
 * minimum: last 24h, last 7d, lifetime).
 */
export function evaluateReputation(input: ReputationPolicyInput, options: EvaluateReputationOptions = {}): ReputationPolicyResult {
  const prefix = options.codePrefix ?? "";
  const last24h = computeWindowEvidence(input.last24h);
  const prior24h = computeWindowEvidence(input.prior24h);
  const last7d = computeWindowEvidence(input.last7d);
  const lifetime = computeWindowEvidence(input.lifetime);

  const trendGate = (recentCount: number, priorCount: number) => recentCount >= MIN_SAMPLE_SIZE_FOR_TREND && priorCount >= MIN_SAMPLE_SIZE_FOR_TREND;
  const canTrend = trendGate(last24h.eventCount, prior24h.eventCount);

  const trends: ReputationTrends = {
    delivery: canTrend ? detectTrend(last24h.deliveryRate, prior24h.deliveryRate, false) : "UNKNOWN",
    bounce: canTrend ? detectTrend(last24h.bounceRate, prior24h.bounceRate, true) : "UNKNOWN",
    throttle: canTrend ? detectTrend(last24h.throttleRate, prior24h.throttleRate, true) : "UNKNOWN",
    failure: canTrend ? detectTrend(last24h.failureRate, prior24h.failureRate, true) : "UNKNOWN",
    complaint: canTrend ? detectTrend(last24h.complaintRate, prior24h.complaintRate, true) : "UNKNOWN",
  };

  // Factors are derived from the last-24h window (Stage 10 spec section 7:
  // "the 24-hour window is important for immediate warmup safety") — the
  // most recent, most decision-relevant evidence, not lifetime totals that
  // could mask a very recent problem behind a long healthy history.
  const factors: ReputationFactor[] = [];
  pushRateFactor(factors, last24h.bounceRate, BOUNCE_RATE_THRESHOLDS, `${prefix}HIGH_BOUNCE_RATE`, (s) => `Bounce rate is elevated (${s.toLowerCase()}) over the last 24 hours.`);
  pushRateFactor(factors, last24h.throttleRate, THROTTLE_RATE_THRESHOLDS, `${prefix}HIGH_THROTTLE_RATE`, (s) => `Provider throttling rate is elevated (${s.toLowerCase()}) over the last 24 hours.`);
  pushRateFactor(factors, last24h.rejectionRate, REJECTION_RATE_THRESHOLDS, `${prefix}HIGH_PROVIDER_REJECTION_RATE`, (s) => `Provider rejection rate is elevated (${s.toLowerCase()}) over the last 24 hours.`);
  pushRateFactor(factors, last24h.failureRate, FAILURE_RATE_THRESHOLDS, `${prefix}HIGH_FAILURE_RATE`, (s) => `Failure rate is elevated (${s.toLowerCase()}) over the last 24 hours.`);

  const complaintCount = input.last24h.COMPLAINT;
  const complaintSeverity = severityForCount(complaintCount, COMPLAINT_COUNT_THRESHOLDS);
  if (complaintSeverity) {
    factors.push({
      code: `${prefix}COMPLAINT_SIGNAL`,
      description: `${complaintCount} complaint(s) observed in the last 24 hours.`,
      severity: complaintSeverity,
    });
  }

  if (trends.delivery === "DEGRADING") {
    factors.push({ code: `${prefix}DEGRADING_DELIVERY_TREND`, description: "Delivery success rate is trending down versus the prior 24-hour window.", severity: "MEDIUM" });
  }
  if (trends.bounce === "DEGRADING") {
    factors.push({ code: `${prefix}DEGRADING_BOUNCE_TREND`, description: "Bounce rate is trending up versus the prior 24-hour window.", severity: "MEDIUM" });
  }
  if (trends.throttle === "DEGRADING") {
    factors.push({ code: `${prefix}DEGRADING_PROVIDER_TREND`, description: "Provider throttling rate is trending up versus the prior 24-hour window.", severity: "MEDIUM" });
  }

  const status = statusFromFactors(factors, lifetime, last7d);
  const confidence = confidenceFromSampleSize(lifetime.eventCount);

  return { status, confidence, factors, trends, last24h, last7d, lifetime };
}

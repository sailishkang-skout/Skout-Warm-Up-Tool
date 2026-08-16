import type { SignalType } from "./signal.js";

export const FRESHNESS_STATUSES = ["FRESH", "STALE", "EXPIRED"] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

interface FreshnessWindow {
  /** A signal younger than this is FRESH. */
  readonly freshUntilMs: number;
  /** A signal older than this is EXPIRED (must be re-collected before it can inform a decision); between the two windows it's STALE (usable, but should be refreshed soon). */
  readonly expiredAfterMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The single central policy Stage 7 spec section 5 asks for — every place
 * that needs to know "is this signal still good enough to act on" reads
 * from here, never a hardcoded number scattered at each call site.
 *
 * Reasoning per category (spec section 5's own examples):
 *   connection health   → short TTL: a provider connection can drop between
 *                          one request and the next; a 5-minute-old
 *                          PROVIDER_CONNECTED/PROVIDER_AUTHENTICATED/
 *                          SEND_CAPABLE/RECEIVE_CAPABLE reading is still
 *                          reasonable to act on, a 30-minute-old one isn't.
 *   DNS records         → longer TTL, matching
 *                          `domain-intelligence`'s own 24h refresh interval
 *                          (see that module's DOMAIN_REFRESH_INTERVAL_MS) —
 *                          DNS changes rarely and deliberately.
 *   mailbox age         → effectively stable once known (not emitted yet —
 *                          see signal.ts — but the window is defined ahead
 *                          of time so nothing needs to change here later).
 *   provider limits     → provider-specific, conservatively short until a
 *                          real source exists (not emitted yet).
 *   activity/reputation  → not emitted yet (see signal.ts); short windows
 *   signals              reserved so they never accidentally get treated as
 *                          long-lived once a real source lands.
 */
export const SIGNAL_FRESHNESS_WINDOWS: Readonly<Record<SignalType, FreshnessWindow>> = {
  PROVIDER_CONNECTED: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  PROVIDER_AUTHENTICATED: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  SMTP_AUTHENTICATED: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  IMAP_AUTHENTICATED: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  SEND_CAPABLE: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  RECEIVE_CAPABLE: { freshUntilMs: 5 * MINUTE_MS, expiredAfterMs: 30 * MINUTE_MS },
  DOMAIN_MX: { freshUntilMs: DAY_MS, expiredAfterMs: 7 * DAY_MS },
  DOMAIN_SPF: { freshUntilMs: DAY_MS, expiredAfterMs: 7 * DAY_MS },
  DOMAIN_DKIM: { freshUntilMs: DAY_MS, expiredAfterMs: 7 * DAY_MS },
  DOMAIN_DMARC: { freshUntilMs: DAY_MS, expiredAfterMs: 7 * DAY_MS },
  MAILBOX_AGE: { freshUntilMs: Number.POSITIVE_INFINITY, expiredAfterMs: Number.POSITIVE_INFINITY },
  PROVIDER_RATE_LIMIT: { freshUntilMs: HOUR_MS, expiredAfterMs: 6 * HOUR_MS },
  RECENT_ACTIVITY: { freshUntilMs: HOUR_MS, expiredAfterMs: 6 * HOUR_MS },
  BOUNCE_SIGNAL: { freshUntilMs: HOUR_MS, expiredAfterMs: DAY_MS },
  COMPLAINT_SIGNAL: { freshUntilMs: HOUR_MS, expiredAfterMs: DAY_MS },
};

export function computeFreshness(signalType: SignalType, observedAt: Date, now: Date = new Date()): FreshnessStatus {
  const window = SIGNAL_FRESHNESS_WINDOWS[signalType];
  const ageMs = now.getTime() - observedAt.getTime();

  if (ageMs <= window.freshUntilMs) {
    return "FRESH";
  }
  if (ageMs <= window.expiredAfterMs) {
    return "STALE";
  }
  return "EXPIRED";
}

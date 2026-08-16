/**
 * The full signal taxonomy this intelligence layer is designed to reason
 * about — deliberately wider than what `application/signal-collector.ts`
 * can actually produce today. Stage 7 spec section 3: "Only implement
 * signals that can actually be measured at this stage." The types below
 * that are NOT yet emitted, and why:
 *
 *   SMTP_AUTHENTICATED / IMAP_AUTHENTICATED — no adapter validates SMTP/IMAP
 *     credentials independently yet (the SMTP/IMAP provider adapter is
 *     still a Stage 5 skeleton); `PROVIDER_AUTHENTICATED` covers what's
 *     actually measurable today (OAuth authentication health) across all
 *     three provider types without inventing a protocol-specific claim.
 *   MAILBOX_AGE — no provider integration in this service exposes a real
 *     account-creation date (see Stage 6's identical conclusion on
 *     `mailboxAgeDays`); time-since-added-to-Skout is a different fact and
 *     would be misleading if labeled "mailbox age."
 *   PROVIDER_RATE_LIMIT — no provider adapter surfaces rate-limit
 *     information to this service.
 *   RECENT_ACTIVITY — no message-send history exists; the warmup engine
 *     that would produce it doesn't exist yet.
 *   BOUNCE_SIGNAL / COMPLAINT_SIGNAL — explicitly deferred per spec:
 *     "those become available later through delivery-event integrations."
 *
 * Each is still declared here so the type is stable once its source
 * exists, and so `freshness.ts`'s per-type policy has somewhere to live
 * ahead of time — declaring a type is not the same as fabricating its data.
 */
export const SIGNAL_TYPES = [
  "PROVIDER_CONNECTED",
  "PROVIDER_AUTHENTICATED",
  "SMTP_AUTHENTICATED",
  "IMAP_AUTHENTICATED",
  "SEND_CAPABLE",
  "RECEIVE_CAPABLE",
  "DOMAIN_MX",
  "DOMAIN_SPF",
  "DOMAIN_DKIM",
  "DOMAIN_DMARC",
  "MAILBOX_AGE",
  "PROVIDER_RATE_LIMIT",
  "RECENT_ACTIVITY",
  "BOUNCE_SIGNAL",
  "COMPLAINT_SIGNAL",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

/**
 * Qualitative, not a probability float — same reasoning Stage 7 spec
 * section 10 applies to risk scores: avoid fake precision like "0.8231".
 * `HIGH` = measured directly from a first-party source (our own DB state,
 * a live provider call, a completed DNS query). `LOW` = a best-effort or
 * partial check (e.g. DKIM's common-selector guess found nothing, which
 * doesn't prove DKIM is absent).
 */
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * What backs a `Signal` — where it came from and how much to trust it.
 * Deliberately a plain value embedded on the signal itself rather than a
 * separate joined record: a `mailbox_signals` row already *is* the
 * evidence for its own value (source, observedAt, confidence, safe
 * metadata) — a second table pointing back at the first would duplicate
 * the same facts for no independent query benefit (Stage 7 spec section
 * 24: "only create tables that are genuinely required").
 *
 * `metadata` must only ever hold safe, structural detail — never a
 * credential, token, or raw provider/DNS error (Stage 7 spec section 4).
 */
export interface Evidence {
  readonly source: string;
  readonly observedAt: Date;
  readonly confidence: ConfidenceLevel;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Signal<TValue = unknown> {
  readonly type: SignalType;
  readonly value: TValue;
  readonly evidence: Evidence;
}

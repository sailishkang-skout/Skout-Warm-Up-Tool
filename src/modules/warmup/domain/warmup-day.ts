const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Warmup day" is a count of elapsed UTC calendar days since the session
 * started, 1-based (the day a session starts is day 1) — never derived
 * from job/message counts (Stage 8 spec section 24: "Do NOT calculate this
 * from number of jobs / number of emails sent" — a paused or stalled
 * session must not silently stay on day 1 forever, and a session that
 * sends nothing on a given day must not repeat that day).
 *
 * Explicitly UTC, not the mailbox's or tenant's local timezone — there is
 * no mailbox timezone concept in this service yet (Stage 8 spec section
 * 24: "Default can be UTC if there is no mailbox timezone yet. Document
 * this."). Using UTC calendar-day boundaries (rather than a fixed 24h
 * duration) means this is DST-safe by construction: UTC has no DST, so
 * there is no local-time gap/overlap to account for.
 */
export function computeWarmupDay(startedAt: Date, now: Date = new Date()): number {
  const startUtcMidnight = Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate());
  const nowUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const elapsedDays = Math.floor((nowUtcMidnight - startUtcMidnight) / DAY_MS);
  return Math.max(1, elapsedDays + 1);
}

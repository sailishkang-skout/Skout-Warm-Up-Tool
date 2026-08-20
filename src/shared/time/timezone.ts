/**
 * IANA-timezone-aware wall-clock conversion, backed entirely by
 * `Intl.DateTimeFormat` (Stage 12 — see `warmup/domain/send-window.ts`'s
 * doc comment for why this codebase uses the platform's built-in ICU
 * rather than adding a timezone library). Lives in `shared/` — not
 * `warmup/domain/` — because it's genuinely domain-agnostic (nothing here
 * knows what a mailbox or a warmup window is) and both `mailbox` (which
 * validates a mailbox's configured timezone) and `warmup` (which evaluates
 * send windows against it) need it; putting it in either module would
 * create a cycle between them.
 *
 * Every function derives an offset or wall-clock reading fresh from
 * `Intl` for the exact instant in question — none of them hardcode or
 * manually add/subtract a UTC offset for a zone, so DST transitions are
 * always resolved by the platform's own tzdata, never guessed at here.
 */

// Newer `Intl.DateTimeFormat` implementations (added for `Temporal`
// interop) also accept fixed-offset strings like `"-05:00"` or `"+09:00"`
// as a `timeZone` value without throwing — exactly what "Do NOT store raw
// UTC offsets... use IANA timezone identifiers" (Stage 12) forbids, since
// an offset carries no DST rule. Rejected explicitly, before ever asking
// `Intl` — an offset never survives a DST transition the way a real IANA
// zone does.
const UTC_OFFSET_PATTERN = /^[+-]\d{2}:?\d{2}$/;

/**
 * An IANA identifier needs two things: it must not be a raw UTC-offset
 * string (see above), and `Intl` must accept it — `Intl.DateTimeFormat`
 * throws `RangeError` for a genuinely unknown zone.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (UTC_OFFSET_PATTERN.test(timezone)) {
    return false;
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function datePartsAsUtcMillis(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * The zone's UTC offset, in minutes, at the exact instant `date` — derived
 * by comparing "what the wall clock reads in `timezone`" against the same
 * instant's actual UTC millis, never a lookup table. Positive east of UTC
 * (matching `Intl`'s own convention).
 */
export function offsetMinutesAt(date: Date, timezone: string): number {
  return (datePartsAsUtcMillis(date, timezone) - date.getTime()) / 60_000;
}

export interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function localDateParts(date: Date, timezone: string): LocalDateParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Pure calendar-day increment on a (year, month, day) triple — never touches wall-clock/offset math, so it's DST-safe by construction. */
export function addLocalDay(parts: LocalDateParts): LocalDateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  next.setUTCDate(next.getUTCDate() + 1);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * Converts a local wall-clock time in `timezone` to the UTC instant it
 * represents. Two-pass offset refinement (the standard technique for this
 * with only `Intl` available): guess the offset from a naive estimate, then
 * re-derive it from the corrected instant in case the first guess landed on
 * the wrong side of a DST transition. This resolves correctly for the
 * overwhelming majority of wall-clock times; the two annual edge cases
 * inherent to DST itself (the repeated hour at "fall back," the
 * nonexistent hour at "spring forward") are not specially disambiguated —
 * every caller of this in this codebase only ever uses it to compute a
 * scheduling *hint* that gets re-verified later, so landing within an hour
 * of the intended instant on those two nights a year is self-correcting,
 * never a safety issue.
 */
export function zonedTimeToUtc(parts: LocalDateParts, minuteOfDay: number, timezone: string): Date {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naiveUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);
  const firstOffset = offsetMinutesAt(new Date(naiveUtcMs), timezone);
  const correctedMs = naiveUtcMs - firstOffset * 60_000;
  const secondOffset = offsetMinutesAt(new Date(correctedMs), timezone);
  return new Date(secondOffset === firstOffset ? correctedMs : naiveUtcMs - secondOffset * 60_000);
}

/** Minutes since local midnight (0-1439) for `date`, read in `timezone`. */
export function localMinuteOfDay(date: Date, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/**
 * Mailbox-local send-window / quiet-hours evaluation (Stage 12 spec
 * "TIMEZONE REQUIREMENTS": "Do NOT implement custom timezone math... use an
 * established timezone-capable library"). This codebase has zero existing
 * date/timezone dependency (`bullmq` is the only date-adjacent package and
 * is unused — see `scheduling/README.md`'s Stage 12 correction), and adding
 * one for a single, bounded need (local wall-clock time inside an IANA
 * zone) would cut against this codebase's consistent bias toward zero new
 * dependencies across eleven prior stages. `shared/time` (`Intl.DateTimeFormat`,
 * backed by the same ICU tzdata every timezone library ultimately delegates
 * to) is the established mechanism used instead — see that module's doc
 * comment for the full reasoning. This file only defines the
 * warmup-specific *policy* shape (a send window is `WarmupProfile`
 * configuration); the timezone arithmetic itself lives in `shared/time`
 * since `mailbox` (which validates a mailbox's configured timezone) needs
 * it too, and `mailbox` cannot depend on `warmup` without creating a module
 * cycle (`warmup` already depends on `mailbox` extensively).
 */
import { addLocalDay, localDateParts, localMinuteOfDay, zonedTimeToUtc } from "../../../shared/time/index.js";

/**
 * `windowStartMinute`/`windowEndMinute` are minutes since local midnight
 * (0-1439). `windowEndMinute <= windowStartMinute` is a valid overnight
 * window (e.g. 22:00-06:00 quiet-hours-inverse), not an error — see
 * `isWithinSendWindow`.
 */
export interface SendWindowConfig {
  readonly timezone: string;
  readonly windowStartMinute: number;
  readonly windowEndMinute: number;
}

function isWithinWindow(windowStartMinute: number, windowEndMinute: number, minute: number): boolean {
  if (windowStartMinute === windowEndMinute) {
    // A zero-width window is a deliberate "never send" configuration, not
    // a silent full-day window — an administrator who sets start === end
    // clearly means to fully suppress sending.
    return false;
  }
  if (windowStartMinute < windowEndMinute) {
    return minute >= windowStartMinute && minute < windowEndMinute;
  }
  // Overnight window wrapping past local midnight.
  return minute >= windowStartMinute || minute < windowEndMinute;
}

/**
 * Pure, deterministic — the scheduler/worker's only source of truth for
 * "is now within this mailbox's configured send window" (Stage 12 spec:
 * "the scheduler may determine whether an action is TIME-ELIGIBLE... it
 * must NOT determine whether the action is SAFE" — this function answers
 * exactly that one question and nothing else).
 */
export function isWithinSendWindow(config: SendWindowConfig, now: Date): boolean {
  const minute = localMinuteOfDay(now, config.timezone);
  return isWithinWindow(config.windowStartMinute, config.windowEndMinute, minute);
}

/**
 * The next UTC instant, at or after `from`, when `config`'s window is open
 * — `from` itself if already inside the window. Used both to set a fresh
 * intent's `scheduledFor` at creation time (so `claimNext` never even
 * considers a window-closed intent in the common case) and to compute a
 * re-queue target when the execution worker finds a claimed intent outside
 * its window at execution time (drift between scheduling and execution —
 * see `application/execution-worker.ts`).
 */
export function nextWindowStart(config: SendWindowConfig, from: Date): Date {
  if (isWithinSendWindow(config, from)) {
    return from;
  }
  const today = localDateParts(from, config.timezone);
  const nowMinute = localMinuteOfDay(from, config.timezone);
  // Correct for both wrap and non-wrap windows: if the local clock hasn't
  // yet reached today's window-start-minute, the window opens later today;
  // otherwise (it already passed, or the window is overnight and we're
  // past both edges) the next opening is tomorrow's window-start.
  const targetDate = nowMinute < config.windowStartMinute ? today : addLocalDay(today);
  return zonedTimeToUtc(targetDate, config.windowStartMinute, config.timezone);
}

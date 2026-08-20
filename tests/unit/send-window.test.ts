import { describe, expect, it } from "vitest";
import { isWithinSendWindow, nextWindowStart, type SendWindowConfig } from "../../src/modules/warmup/domain/send-window.js";
import { localMinuteOfDay } from "../../src/shared/time/index.js";

describe("isWithinSendWindow", () => {
  const nonWrapping: SendWindowConfig = { timezone: "America/New_York", windowStartMinute: 8 * 60, windowEndMinute: 20 * 60 }; // 08:00-20:00

  it("is eligible inside a normal (non-overnight) window", () => {
    // 14:00 EST = 19:00 UTC (settled winter offset, well clear of any DST boundary)
    expect(isWithinSendWindow(nonWrapping, new Date("2026-01-15T19:00:00Z"))).toBe(true);
  });

  it("is not eligible before a normal window opens", () => {
    // 03:00 EST = 08:00 UTC
    expect(isWithinSendWindow(nonWrapping, new Date("2026-01-15T08:00:00Z"))).toBe(false);
  });

  it("is not eligible after a normal window closes", () => {
    // 22:00 EST = 03:00 UTC the next day
    expect(isWithinSendWindow(nonWrapping, new Date("2026-01-16T03:00:00Z"))).toBe(false);
  });

  it("the window start minute itself is eligible (inclusive), the end minute is not (exclusive)", () => {
    // 08:00 EST = 13:00 UTC
    expect(isWithinSendWindow(nonWrapping, new Date("2026-01-15T13:00:00Z"))).toBe(true);
    // 20:00 EST = 01:00 UTC next day
    expect(isWithinSendWindow(nonWrapping, new Date("2026-01-16T01:00:00Z"))).toBe(false);
  });

  const overnight: SendWindowConfig = { timezone: "America/New_York", windowStartMinute: 22 * 60, windowEndMinute: 6 * 60 }; // 22:00-06:00

  it("is eligible late at night in an overnight window", () => {
    // 23:00 EST = 04:00 UTC next day
    expect(isWithinSendWindow(overnight, new Date("2026-01-16T04:00:00Z"))).toBe(true);
  });

  it("is eligible early morning (past local midnight) in an overnight window", () => {
    // 02:00 EST = 07:00 UTC
    expect(isWithinSendWindow(overnight, new Date("2026-01-15T07:00:00Z"))).toBe(true);
  });

  it("is not eligible during the daytime gap of an overnight window", () => {
    // 12:00 EST = 17:00 UTC
    expect(isWithinSendWindow(overnight, new Date("2026-01-15T17:00:00Z"))).toBe(false);
  });

  it("a zero-width window (start === end) is a deliberate never-send configuration", () => {
    const neverSend: SendWindowConfig = { timezone: "UTC", windowStartMinute: 600, windowEndMinute: 600 };
    expect(isWithinSendWindow(neverSend, new Date("2026-01-15T10:00:00Z"))).toBe(false);
    expect(isWithinSendWindow(neverSend, new Date("2026-01-15T00:00:00Z"))).toBe(false);
  });
});

describe("nextWindowStart", () => {
  const window: SendWindowConfig = { timezone: "America/New_York", windowStartMinute: 8 * 60, windowEndMinute: 20 * 60 }; // 08:00-20:00

  it("returns the same instant when already inside the window", () => {
    const now = new Date("2026-01-15T19:00:00Z"); // 14:00 EST
    expect(nextWindowStart(window, now)).toEqual(now);
  });

  it("returns later today's window-start when the window hasn't opened yet today", () => {
    const now = new Date("2026-01-15T08:00:00Z"); // 03:00 EST
    const next = nextWindowStart(window, now);
    expect(localMinuteOfDay(next, "America/New_York")).toBe(8 * 60);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it("returns tomorrow's window-start when today's window already closed", () => {
    const now = new Date("2026-01-16T03:00:00Z"); // 22:00 EST on Jan 15
    const next = nextWindowStart(window, now);
    expect(localMinuteOfDay(next, "America/New_York")).toBe(8 * 60);
    // Should be tomorrow (Jan 16), not today (Jan 15) again.
    const hoursUntilNext = (next.getTime() - now.getTime()) / (60 * 60 * 1000);
    expect(hoursUntilNext).toBeGreaterThan(0);
    expect(hoursUntilNext).toBeLessThan(24);
  });

  it("correctly resolves the next opening for an overnight window", () => {
    const overnight: SendWindowConfig = { timezone: "America/New_York", windowStartMinute: 22 * 60, windowEndMinute: 6 * 60 };
    const now = new Date("2026-01-15T17:00:00Z"); // 12:00 EST — mid-day gap
    const next = nextWindowStart(overnight, now);
    expect(localMinuteOfDay(next, "America/New_York")).toBe(22 * 60);
    expect(isWithinSendWindow(overnight, next)).toBe(true);
  });

  it("is deterministic", () => {
    const now = new Date("2026-01-15T08:00:00Z");
    expect(nextWindowStart(window, now)).toEqual(nextWindowStart(window, now));
  });
});

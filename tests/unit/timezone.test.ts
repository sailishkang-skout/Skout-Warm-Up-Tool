import { describe, expect, it } from "vitest";
import { addLocalDay, isValidIanaTimezone, localDateParts, localMinuteOfDay, offsetMinutesAt, zonedTimeToUtc } from "../../src/shared/time/index.js";

describe("isValidIanaTimezone", () => {
  it("accepts a real IANA identifier", () => {
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(true);
    expect(isValidIanaTimezone("Asia/Tokyo")).toBe(true);
  });

  it("rejects a raw UTC offset — this codebase requires IANA identifiers, never offsets (some Intl implementations otherwise accept these as a Temporal-interop timeZone value)", () => {
    expect(isValidIanaTimezone("-05:00")).toBe(false);
    expect(isValidIanaTimezone("+09:00")).toBe(false);
    expect(isValidIanaTimezone("+0900")).toBe(false);
  });

  it("rejects garbage input without throwing", () => {
    expect(isValidIanaTimezone("Not/A_Real_Zone")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });
});

describe("offsetMinutesAt", () => {
  it("is 0 for UTC at any instant", () => {
    expect(offsetMinutesAt(new Date("2026-01-15T12:00:00Z"), "UTC")).toBe(0);
    expect(offsetMinutesAt(new Date("2026-07-15T12:00:00Z"), "UTC")).toBe(0);
  });

  it("resolves America/New_York's settled winter (EST, UTC-5) and summer (EDT, UTC-4) offsets without hardcoding a transition date", () => {
    // Deliberately well clear of any DST transition boundary on either
    // side, so this test never depends on knowing the exact transition
    // date for a given year — only the well-established settled values.
    expect(offsetMinutesAt(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(offsetMinutesAt(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("resolves a positive (east of UTC) offset correctly", () => {
    expect(offsetMinutesAt(new Date("2026-01-15T12:00:00Z"), "Asia/Tokyo")).toBe(540); // UTC+9, no DST
  });
});

describe("zonedTimeToUtc / localDateParts / localMinuteOfDay round-trip", () => {
  it("round-trips a local wall-clock time back to the same local minute-of-day", () => {
    const parts = { year: 2026, month: 6, day: 15 };
    const utcInstant = zonedTimeToUtc(parts, 9 * 60 + 30, "America/New_York"); // 09:30 local
    expect(localMinuteOfDay(utcInstant, "America/New_York")).toBe(9 * 60 + 30);
    expect(localDateParts(utcInstant, "America/New_York")).toEqual(parts);
  });

  it("correctly converts across a known settled EST offset", () => {
    const parts = { year: 2026, month: 1, day: 15 };
    const utcInstant = zonedTimeToUtc(parts, 0, "America/New_York"); // midnight EST = 05:00 UTC
    expect(utcInstant.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
});

describe("addLocalDay", () => {
  it("increments a plain calendar date", () => {
    expect(addLocalDay({ year: 2026, month: 1, day: 15 })).toEqual({ year: 2026, month: 1, day: 16 });
  });

  it("rolls over a month boundary", () => {
    expect(addLocalDay({ year: 2026, month: 1, day: 31 })).toEqual({ year: 2026, month: 2, day: 1 });
  });

  it("rolls over a year boundary", () => {
    expect(addLocalDay({ year: 2025, month: 12, day: 31 })).toEqual({ year: 2026, month: 1, day: 1 });
  });
});

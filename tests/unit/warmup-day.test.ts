import { describe, expect, it } from "vitest";
import { computeWarmupDay } from "../../src/modules/warmup/domain/warmup-day.js";

describe("computeWarmupDay", () => {
  it("is day 1 at the exact moment a session starts", () => {
    const startedAt = new Date("2026-03-10T14:00:00.000Z");
    expect(computeWarmupDay(startedAt, startedAt)).toBe(1);
  });

  it("stays day 1 later the same UTC calendar day", () => {
    const startedAt = new Date("2026-03-10T01:00:00.000Z");
    const now = new Date("2026-03-10T23:59:59.000Z");
    expect(computeWarmupDay(startedAt, now)).toBe(1);
  });

  it("advances to day 2 the instant UTC midnight passes, even seconds later", () => {
    const startedAt = new Date("2026-03-10T23:59:00.000Z");
    const now = new Date("2026-03-11T00:00:01.000Z");
    expect(computeWarmupDay(startedAt, now)).toBe(2);
  });

  it("counts elapsed UTC calendar days, not 24h windows", () => {
    const startedAt = new Date("2026-03-10T12:00:00.000Z");
    const now = new Date("2026-03-13T01:00:00.000Z");
    expect(computeWarmupDay(startedAt, now)).toBe(4);
  });

  it("is unaffected by a DST transition — UTC has none", () => {
    // US DST spring-forward 2026-03-08; this window spans it, but UTC day
    // counting never sees a gap or a repeated hour.
    const startedAt = new Date("2026-03-07T12:00:00.000Z");
    const now = new Date("2026-03-09T12:00:00.000Z");
    expect(computeWarmupDay(startedAt, now)).toBe(3);
  });

  it("never returns less than 1, even if `now` is somehow before `startedAt`", () => {
    const startedAt = new Date("2026-03-10T00:00:00.000Z");
    const now = new Date("2026-03-09T00:00:00.000Z");
    expect(computeWarmupDay(startedAt, now)).toBe(1);
  });
});

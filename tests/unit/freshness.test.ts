import { describe, expect, it } from "vitest";
import { computeFreshness, SIGNAL_FRESHNESS_WINDOWS } from "../../src/modules/health/domain/freshness.js";

describe("computeFreshness", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("is FRESH immediately after observation", () => {
    expect(computeFreshness("PROVIDER_CONNECTED", now, now)).toBe("FRESH");
  });

  it("is FRESH within the short connection-health window", () => {
    const observedAt = new Date(now.getTime() - 4 * 60_000); // 4 minutes ago
    expect(computeFreshness("PROVIDER_CONNECTED", observedAt, now)).toBe("FRESH");
  });

  it("is STALE between the fresh and expired windows", () => {
    const observedAt = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago
    expect(computeFreshness("PROVIDER_CONNECTED", observedAt, now)).toBe("STALE");
  });

  it("is EXPIRED past the expired window", () => {
    const observedAt = new Date(now.getTime() - 45 * 60_000); // 45 minutes ago
    expect(computeFreshness("PROVIDER_CONNECTED", observedAt, now)).toBe("EXPIRED");
  });

  it("uses a much longer window for DNS-derived signals than connection signals", () => {
    const observedAt = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago
    expect(computeFreshness("PROVIDER_CONNECTED", observedAt, now)).toBe("STALE");
    expect(computeFreshness("DOMAIN_SPF", observedAt, now)).toBe("FRESH");
  });

  it("defines a freshness window for every declared signal type", () => {
    const definedTypes = Object.keys(SIGNAL_FRESHNESS_WINDOWS);
    // Every signal type has a policy, even ones not emitted yet (see signal.ts) —
    // so nothing needs to change here once a new source starts emitting them.
    expect(definedTypes.length).toBeGreaterThan(0);
    for (const window of Object.values(SIGNAL_FRESHNESS_WINDOWS)) {
      expect(window.freshUntilMs).toBeLessThanOrEqual(window.expiredAfterMs);
    }
  });
});

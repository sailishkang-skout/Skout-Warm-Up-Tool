import { afterEach, describe, expect, it } from "vitest";
import {
  incrementCounter,
  METRIC,
  readCounter,
  readGauge,
  resetCountersForTests,
  setGauge,
} from "../../src/shared/observability/index.js";

describe("process metrics", () => {
  afterEach(() => {
    resetCountersForTests();
  });

  it("counts without attaching business payloads", () => {
    incrementCounter(METRIC.integrationEventsRead, 3);
    expect(readCounter(METRIC.integrationEventsRead)).toBe(3);
    expect(METRIC.integrationEventsRead).not.toMatch(/body|token|secret/i);
  });

  it("keeps tenant pool metrics and warmup-network route metrics as names only", () => {
    expect(METRIC.warmupPoolSelection).toBe("warmup.pool.selection");
    expect(METRIC.warmupNetworkRouteAttempt).toBe("warmup_network.route.attempt");
    expect(METRIC.warmupNetworkRouteSuccess).toBe("warmup_network.route.success");
    expect(METRIC.warmupNetworkRouteNoEligible).toBe("warmup_network.route.no_eligible");
    expect(METRIC.warmupNetworkRouteFailure).toBe("warmup_network.route.failure");
    expect(METRIC.warmupNetworkRouteAuthFailed).toBe("warmup_network.route.auth_failed");
    expect(METRIC.warmupNetworkRouteCapacityExhausted).toBe("warmup_network.route.capacity_exhausted");
    expect(METRIC.warmupNetworkRouteQuarantined).toBe("warmup_network.route.quarantined");
    expect(METRIC.warmupNetworkRouteProviderMismatch).toBe("warmup_network.route.provider_mismatch");
    expect(METRIC.warmupNetworkCapacityRemaining).toBe("warmup_network.capacity.remaining");
    expect(METRIC.warmupNetworkMailboxSelected).toBe("warmup_network.mailbox.selected");
    expect(METRIC.warmupNetworkDomainSelected).toBe("warmup_network.domain.selected");
    for (const name of Object.values(METRIC)) {
      expect(name).not.toMatch(/token|secret|password|body|pii/i);
    }
    setGauge(METRIC.warmupNetworkCapacityRemaining, 12);
    expect(readGauge(METRIC.warmupNetworkCapacityRemaining)).toBe(12);
    resetCountersForTests();
    expect(readGauge(METRIC.warmupNetworkCapacityRemaining)).toBe(0);
  });
});

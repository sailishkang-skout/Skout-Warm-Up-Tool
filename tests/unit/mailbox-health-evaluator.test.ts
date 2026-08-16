import { describe, expect, it } from "vitest";
import { evaluateHealth } from "../../src/modules/health/application/mailbox-health-evaluator.js";
import type { Signal } from "../../src/modules/health/domain/signal.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function signal(type: Signal["type"], value: unknown, observedAt: Date = NOW): Signal {
  return { type, value, evidence: { source: "test", observedAt, confidence: "HIGH" } };
}

describe("evaluateHealth", () => {
  it("returns UNKNOWN for every dimension when no signals are present", () => {
    const health = evaluateHealth([], true, NOW);
    expect(health.connection).toBe("UNKNOWN");
    expect(health.authentication).toBe("UNKNOWN");
    expect(health.sending).toBe("UNKNOWN");
    expect(health.receiving).toBe("UNKNOWN");
    expect(health.domain).toBe("UNKNOWN");
  });

  it("maps a fully healthy mailbox to HEALTHY across every dimension", () => {
    const signals: Signal[] = [
      signal("PROVIDER_CONNECTED", true),
      signal("PROVIDER_AUTHENTICATED", "HEALTHY"),
      signal("SEND_CAPABLE", true),
      signal("RECEIVE_CAPABLE", true),
      signal("DOMAIN_MX", "PASS"),
      signal("DOMAIN_SPF", "PASS"),
      signal("DOMAIN_DMARC", "PASS"),
    ];
    const health = evaluateHealth(signals, true, NOW);
    expect(health).toMatchObject({
      connection: "HEALTHY",
      authentication: "HEALTHY",
      sending: "HEALTHY",
      receiving: "HEALTHY",
      domain: "HEALTHY",
      configuration: "HEALTHY",
    });
  });

  it("maps a disconnected mailbox to UNHEALTHY connection", () => {
    const health = evaluateHealth([signal("PROVIDER_CONNECTED", false)], true, NOW);
    expect(health.connection).toBe("UNHEALTHY");
  });

  it("maps provider health statuses to the coarser HealthStatus vocabulary", () => {
    expect(evaluateHealth([signal("PROVIDER_AUTHENTICATED", "DEGRADED")], true, NOW).authentication).toBe("DEGRADED");
    expect(evaluateHealth([signal("PROVIDER_AUTHENTICATED", "UNAUTHENTICATED")], true, NOW).authentication).toBe("UNHEALTHY");
    expect(evaluateHealth([signal("PROVIDER_AUTHENTICATED", "UNAVAILABLE")], true, NOW).authentication).toBe("UNHEALTHY");
  });

  it("domain health is DEGRADED when MX passes but SPF/DMARC do not", () => {
    const health = evaluateHealth(
      [signal("DOMAIN_MX", "PASS"), signal("DOMAIN_SPF", "MISSING"), signal("DOMAIN_DMARC", "MISSING")],
      true,
      NOW,
    );
    expect(health.domain).toBe("DEGRADED");
  });

  it("domain health is UNHEALTHY when MX itself fails", () => {
    const health = evaluateHealth([signal("DOMAIN_MX", "MISSING")], true, NOW);
    expect(health.domain).toBe("UNHEALTHY");
  });

  it("DKIM status alone never affects domain health (best-effort selector guess)", () => {
    const healthyExceptDkim = evaluateHealth(
      [
        signal("DOMAIN_MX", "PASS"),
        signal("DOMAIN_SPF", "PASS"),
        signal("DOMAIN_DMARC", "PASS"),
        signal("DOMAIN_DKIM", "MISSING"),
      ],
      true,
      NOW,
    );
    expect(healthyExceptDkim.domain).toBe("HEALTHY");
  });

  it("configuration health is DEGRADED when the mailbox is disabled", () => {
    expect(evaluateHealth([], false, NOW).configuration).toBe("DEGRADED");
    expect(evaluateHealth([], true, NOW).configuration).toBe("HEALTHY");
  });

  it("uses only the most recently observed signal of each type", () => {
    const signals: Signal[] = [
      signal("PROVIDER_CONNECTED", false, new Date(NOW.getTime() - 60_000)),
      signal("PROVIDER_CONNECTED", true, NOW),
    ];
    expect(evaluateHealth(signals, true, NOW).connection).toBe("HEALTHY");
  });
});

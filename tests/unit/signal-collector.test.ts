import { describe, expect, it } from "vitest";
import { collectSignals } from "../../src/modules/health/application/signal-collector.js";
import type { ConnectionHealthSnapshot } from "../../src/modules/mailbox/application/mailbox-service.js";
import { asMailboxId } from "../../src/shared/types/index.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function connectionHealth(overrides: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot {
  return {
    mailboxId: asMailboxId("11111111-1111-1111-1111-111111111111"),
    provider: "GMAIL",
    status: "HEALTHY",
    authenticationStatus: "HEALTHY",
    checkedAt: NOW,
    sendCapability: true,
    receiveCapability: true,
    ...overrides,
  };
}

describe("collectSignals", () => {
  it("emits a boolean PROVIDER_CONNECTED signal derived from mailbox status, not from provider health", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: undefined,
      observedAt: NOW,
    });
    const connected = signals.find((s) => s.type === "PROVIDER_CONNECTED");
    expect(connected?.value).toBe(true);

    const disconnected = collectSignals({
      mailboxStatus: "DISCONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: undefined,
      observedAt: NOW,
    }).find((s) => s.type === "PROVIDER_CONNECTED");
    expect(disconnected?.value).toBe(false);
  });

  it("emits SEND_CAPABLE/RECEIVE_CAPABLE straight from the connection health snapshot — no provider branching", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth({ sendCapability: true, receiveCapability: false }),
      domainAssessment: undefined,
      observedAt: NOW,
    });
    expect(signals.find((s) => s.type === "SEND_CAPABLE")?.value).toBe(true);
    expect(signals.find((s) => s.type === "RECEIVE_CAPABLE")?.value).toBe(false);
  });

  it("emits no DOMAIN_* signals when no domain assessment is available", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: undefined,
      observedAt: NOW,
    });
    expect(signals.some((s) => s.type.startsWith("DOMAIN_"))).toBe(false);
  });

  it("emits all four DOMAIN_* signals when a domain assessment is available", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: {
        domain: "example.com",
        mx: { status: "PASS", records: ["mx1.example.com"] },
        spf: { status: "PASS", record: "v=spf1 -all" },
        dkim: { status: "MISSING" },
        dmarc: { status: "PASS", policy: "reject", record: "v=DMARC1; p=reject" },
        checkedAt: NOW,
      },
      observedAt: NOW,
    });
    expect(signals.map((s) => s.type)).toEqual(
      expect.arrayContaining(["DOMAIN_MX", "DOMAIN_SPF", "DOMAIN_DKIM", "DOMAIN_DMARC"]),
    );
    expect(signals.find((s) => s.type === "DOMAIN_DMARC")?.value).toBe("PASS");
  });

  it("gives DKIM lower confidence than the other domain signals when it did not resolve", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: {
        domain: "example.com",
        mx: { status: "PASS", records: [] },
        spf: { status: "PASS", record: "v=spf1 -all" },
        dkim: { status: "MISSING" },
        dmarc: { status: "PASS", policy: "reject" },
        checkedAt: NOW,
      },
      observedAt: NOW,
    });
    expect(signals.find((s) => s.type === "DOMAIN_DKIM")?.evidence.confidence).toBe("MEDIUM");
    expect(signals.find((s) => s.type === "DOMAIN_SPF")?.evidence.confidence).toBe("HIGH");
  });

  it("never includes a credential/token-shaped key anywhere in emitted evidence metadata", () => {
    const signals = collectSignals({
      mailboxStatus: "CONNECTED",
      connectionHealth: connectionHealth(),
      domainAssessment: undefined,
      observedAt: NOW,
    });
    const serialized = JSON.stringify(signals);
    expect(serialized).not.toMatch(/accessToken|refreshToken|password|secret/i);
  });
});

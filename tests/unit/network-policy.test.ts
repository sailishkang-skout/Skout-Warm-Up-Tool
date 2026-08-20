import { describe, expect, it } from "vitest";
import { evaluateNetworkPolicy } from "../../src/modules/warmup-network/domain/network-policy.js";

describe("evaluateNetworkPolicy", () => {
  it("does not replace eligibility when there are no candidates", () => {
    expect(
      evaluateNetworkPolicy({
        mailboxes: 0,
        activeMailboxes: 0,
        degradedMailboxes: 0,
        quarantinedMailboxes: 0,
        credentialUnavailable: 0,
        remainingMailboxCapacityToday: 0,
        activeNetworks: 0,
      }),
    ).toEqual({ decision: "ALLOW", reason: "NO_CANDIDATES" });
  });

  it("reduces routing when a large share of members are unhealthy", () => {
    const result = evaluateNetworkPolicy({
      mailboxes: 10,
      activeMailboxes: 4,
      degradedMailboxes: 4,
      quarantinedMailboxes: 1,
      credentialUnavailable: 2,
      remainingMailboxCapacityToday: 20,
      activeNetworks: 1,
    });
    expect(result.decision).toBe("REDUCE");
  });

  it("never encodes mailbox risk from network health", () => {
    const result = evaluateNetworkPolicy({
      mailboxes: 4,
      activeMailboxes: 4,
      degradedMailboxes: 0,
      quarantinedMailboxes: 0,
      credentialUnavailable: 0,
      remainingMailboxCapacityToday: 40,
      activeNetworks: 1,
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.reason).toBe("NETWORK_HEALTHY");
  });
});

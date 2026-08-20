import { describe, expect, it } from "vitest";
import { canTransitionOperationalStatus } from "../../src/modules/mailbox/domain/mailbox-operational-status.js";

describe("mailbox operational status", () => {
  it("keeps connection lifecycle separate from operational lifecycle", () => {
    expect(canTransitionOperationalStatus("DISCOVERED", "PROVISIONING")).toBe(true);
    expect(canTransitionOperationalStatus("READY", "WARMING")).toBe(true);
    expect(canTransitionOperationalStatus("DELETED", "READY")).toBe(false);
  });
});

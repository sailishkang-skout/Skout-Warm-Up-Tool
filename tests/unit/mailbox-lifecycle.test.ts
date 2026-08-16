import { describe, expect, it } from "vitest";
import {
  assertValidMailboxTransition,
  canTransitionMailboxStatus,
} from "../../src/modules/mailbox/domain/mailbox-lifecycle.js";
import { MAILBOX_STATUSES, type MailboxStatus } from "../../src/modules/mailbox/domain/mailbox.js";
import { ConflictError } from "../../src/shared/errors/index.js";

const VALID_TRANSITIONS: Array<[MailboxStatus, MailboxStatus]> = [
  ["PENDING", "CONNECTING"],
  ["CONNECTING", "CONNECTED"],
  ["CONNECTING", "ERROR"],
  ["CONNECTED", "DISCONNECTED"],
  ["CONNECTED", "ERROR"],
  ["DISCONNECTED", "CONNECTING"],
  ["ERROR", "CONNECTING"],
  ["ERROR", "DISCONNECTED"],
];

describe("canTransitionMailboxStatus / assertValidMailboxTransition", () => {
  it.each(VALID_TRANSITIONS)("allows %s -> %s", (from, to) => {
    expect(canTransitionMailboxStatus(from, to)).toBe(true);
    expect(() => assertValidMailboxTransition(from, to)).not.toThrow();
  });

  it("rejects jumping straight to CONNECTED from PENDING", () => {
    expect(canTransitionMailboxStatus("PENDING", "CONNECTED")).toBe(false);
    expect(() => assertValidMailboxTransition("PENDING", "CONNECTED")).toThrow(ConflictError);
  });

  it("rejects PENDING -> DISCONNECTED (nothing active to disconnect)", () => {
    expect(canTransitionMailboxStatus("PENDING", "DISCONNECTED")).toBe(false);
  });

  it("rejects CONNECTING -> DISCONNECTED (nothing active to disconnect)", () => {
    expect(canTransitionMailboxStatus("CONNECTING", "DISCONNECTED")).toBe(false);
  });

  it("rejects a state transitioning to itself (no self-loops in the graph)", () => {
    for (const status of MAILBOX_STATUSES) {
      expect(canTransitionMailboxStatus(status, status)).toBe(false);
    }
  });

  it("rejects DISCONNECTED -> ERROR (must go through CONNECTING first)", () => {
    expect(canTransitionMailboxStatus("DISCONNECTED", "ERROR")).toBe(false);
  });

  it("PENDING, DISCONNECTED, and ERROR can all reach CONNECTING (first attempt / retry / reconnect)", () => {
    expect(canTransitionMailboxStatus("PENDING", "CONNECTING")).toBe(true);
    expect(canTransitionMailboxStatus("DISCONNECTED", "CONNECTING")).toBe(true);
    expect(canTransitionMailboxStatus("ERROR", "CONNECTING")).toBe(true);
  });

  it("CONNECTING cannot reach itself, and CONNECTED must go through DISCONNECTED/ERROR before reconnecting", () => {
    expect(canTransitionMailboxStatus("CONNECTING", "CONNECTING")).toBe(false);
    expect(canTransitionMailboxStatus("CONNECTED", "CONNECTING")).toBe(false);
  });

  it("throws a ConflictError with a message naming both states", () => {
    expect(() => assertValidMailboxTransition("PENDING", "CONNECTED")).toThrow(/PENDING.*CONNECTED/);
  });
});

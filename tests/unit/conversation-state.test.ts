import { describe, expect, it } from "vitest";
import {
  InvalidConversationTransitionError,
  initialConversationState,
  transitionConversationState,
  type ConversationCommand,
  type ConversationState,
} from "../../src/modules/conversations/domain/conversation-state.js";

describe("conversation state machine", () => {
  it("starts AWAITING_REPLY for outbound and REPLIED for inbound", () => {
    expect(initialConversationState("OUTBOUND")).toBe("AWAITING_REPLY");
    expect(initialConversationState("INBOUND")).toBe("REPLIED");
  });

  const valid: ReadonlyArray<[ConversationState, ConversationCommand, ConversationState]> = [
    ["ACTIVE", "RECORD_OUTBOUND", "AWAITING_REPLY"],
    ["ACTIVE", "RECORD_INBOUND", "REPLIED"],
    ["AWAITING_REPLY", "RECORD_INBOUND", "REPLIED"],
    ["REPLIED", "RECORD_OUTBOUND", "AWAITING_REPLY"],
    ["REPLIED", "RECORD_INBOUND", "REPLIED"],
    ["AWAITING_REPLY", "CLOSE", "CLOSED"],
  ];

  it.each(valid)("%s + %s -> %s", (from, command, to) => {
    expect(transitionConversationState(from, command)).toBe(to);
  });

  it("does not allow recording into CLOSED", () => {
    expect(() => transitionConversationState("CLOSED", "RECORD_INBOUND")).toThrow(InvalidConversationTransitionError);
    expect(() => transitionConversationState("CLOSED", "RECORD_OUTBOUND")).toThrow(InvalidConversationTransitionError);
  });
});

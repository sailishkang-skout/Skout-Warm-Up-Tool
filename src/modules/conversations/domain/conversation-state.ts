/**
 * Conversation lifecycle is independent of warmup_sessions.state and of
 * mailbox connection state. Stage 13A records facts only — inbound is never
 * classified as positive/negative, and CLOSED is never inferred from content.
 */
export const CONVERSATION_STATES = ["ACTIVE", "AWAITING_REPLY", "REPLIED", "CLOSED"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_COMMANDS = ["RECORD_OUTBOUND", "RECORD_INBOUND", "CLOSE"] as const;
export type ConversationCommand = (typeof CONVERSATION_COMMANDS)[number];

const TRANSITIONS: Readonly<Record<ConversationState, Partial<Record<ConversationCommand, ConversationState>>>> = {
  ACTIVE: { RECORD_OUTBOUND: "AWAITING_REPLY", RECORD_INBOUND: "REPLIED", CLOSE: "CLOSED" },
  AWAITING_REPLY: { RECORD_OUTBOUND: "AWAITING_REPLY", RECORD_INBOUND: "REPLIED", CLOSE: "CLOSED" },
  REPLIED: { RECORD_OUTBOUND: "AWAITING_REPLY", RECORD_INBOUND: "REPLIED", CLOSE: "CLOSED" },
  CLOSED: {},
};

export class InvalidConversationTransitionError extends Error {
  readonly currentState: ConversationState;
  readonly command: ConversationCommand;

  constructor(currentState: ConversationState, command: ConversationCommand) {
    super(`Cannot apply command '${command}' to a conversation in state '${currentState}'`);
    this.name = "InvalidConversationTransitionError";
    this.currentState = currentState;
    this.command = command;
  }
}

export function transitionConversationState(current: ConversationState, command: ConversationCommand): ConversationState {
  const next = TRANSITIONS[current][command];
  if (!next) {
    throw new InvalidConversationTransitionError(current, command);
  }
  return next;
}

export function initialConversationState(direction: "INBOUND" | "OUTBOUND"): ConversationState {
  return direction === "OUTBOUND" ? "AWAITING_REPLY" : "REPLIED";
}

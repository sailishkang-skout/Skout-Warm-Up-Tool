/**
 * Connection lifecycle (`mailbox`) and warmup lifecycle are deliberately
 * separate state machines — a mailbox can be CONNECTED while its warmup
 * session is PAUSED, or DISCONNECTED while a warmup session is still
 * nominally ACTIVE (the safety gate is what actually blocks execution in
 * that case, not the state machine itself; see `safety-gate.ts`).
 */
export const WARMUP_STATES = ["DRAFT", "ACTIVE", "PAUSED", "COOLDOWN", "COMPLETED", "STOPPED", "FAILED"] as const;
export type WarmupState = (typeof WARMUP_STATES)[number];

/**
 * One command per state-machine edge (Stage 8 spec section 3's exact
 * transition list) — deliberately not a single generic "ACTIVATE" shared
 * across DRAFT→ACTIVE/PAUSED→ACTIVE/COOLDOWN→ACTIVE, so the API layer's
 * intent (start vs. resume) is explicit in the command itself, not inferred
 * from the current state.
 */
export const WARMUP_COMMANDS = ["START", "PAUSE", "ENTER_COOLDOWN", "RESUME", "COMPLETE", "STOP", "FAIL", "RECOVER"] as const;
export type WarmupCommand = (typeof WARMUP_COMMANDS)[number];

/**
 * The exact transition graph from Stage 8 spec section 3. Deliberately a
 * flat lookup table, not a switch statement — makes "is this edge allowed"
 * a single map read, and makes the whole graph readable in one place for
 * review.
 */
const TRANSITIONS: Readonly<Record<WarmupState, Partial<Record<WarmupCommand, WarmupState>>>> = {
  DRAFT: { START: "ACTIVE", STOP: "STOPPED" },
  ACTIVE: { PAUSE: "PAUSED", ENTER_COOLDOWN: "COOLDOWN", COMPLETE: "COMPLETED", STOP: "STOPPED", FAIL: "FAILED" },
  PAUSED: { RESUME: "ACTIVE", STOP: "STOPPED" },
  COOLDOWN: { RESUME: "ACTIVE", STOP: "STOPPED" },
  FAILED: { RECOVER: "PAUSED", STOP: "STOPPED" },
  COMPLETED: { STOP: "STOPPED" },
  STOPPED: {},
};

export class InvalidWarmupTransitionError extends Error {
  readonly currentState: WarmupState;
  readonly command: WarmupCommand;

  constructor(currentState: WarmupState, command: WarmupCommand) {
    super(`Cannot apply command '${command}' to a warmup session in state '${currentState}'`);
    this.name = "InvalidWarmupTransitionError";
    this.currentState = currentState;
    this.command = command;
  }
}

/**
 * Pure — no I/O, no persistence. Returns the resulting state, or throws
 * `InvalidWarmupTransitionError` for any edge not explicitly listed in
 * `TRANSITIONS` above (Stage 8 spec section 3: "Do NOT allow arbitrary
 * state changes"). Callers (application/warmup-service.ts) are responsible
 * for persisting the result and for translating the thrown error into a
 * safe, typed `PolicyError`/`ConflictError` at the API boundary.
 */
export function transitionWarmupState(current: WarmupState, command: WarmupCommand): WarmupState {
  const next = TRANSITIONS[current][command];
  if (!next) {
    throw new InvalidWarmupTransitionError(current, command);
  }
  return next;
}

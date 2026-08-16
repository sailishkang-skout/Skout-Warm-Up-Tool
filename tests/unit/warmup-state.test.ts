import { describe, expect, it } from "vitest";
import { InvalidWarmupTransitionError, transitionWarmupState, type WarmupCommand, type WarmupState } from "../../src/modules/warmup/domain/warmup-state.js";

describe("transitionWarmupState", () => {
  const validEdges: ReadonlyArray<[WarmupState, WarmupCommand, WarmupState]> = [
    ["DRAFT", "START", "ACTIVE"],
    ["DRAFT", "STOP", "STOPPED"],
    ["ACTIVE", "PAUSE", "PAUSED"],
    ["ACTIVE", "ENTER_COOLDOWN", "COOLDOWN"],
    ["ACTIVE", "COMPLETE", "COMPLETED"],
    ["ACTIVE", "STOP", "STOPPED"],
    ["ACTIVE", "FAIL", "FAILED"],
    ["PAUSED", "RESUME", "ACTIVE"],
    ["PAUSED", "STOP", "STOPPED"],
    ["COOLDOWN", "RESUME", "ACTIVE"],
    ["COOLDOWN", "STOP", "STOPPED"],
    ["FAILED", "RECOVER", "PAUSED"],
    ["FAILED", "STOP", "STOPPED"],
    ["COMPLETED", "STOP", "STOPPED"],
  ];

  it.each(validEdges)("allows %s + %s -> %s", (from, command, to) => {
    expect(transitionWarmupState(from, command)).toBe(to);
  });

  const invalidEdges: ReadonlyArray<[WarmupState, WarmupCommand]> = [
    ["DRAFT", "PAUSE"],
    ["DRAFT", "RESUME"],
    ["DRAFT", "COMPLETE"],
    ["DRAFT", "FAIL"],
    ["DRAFT", "ENTER_COOLDOWN"],
    ["DRAFT", "RECOVER"],
    ["ACTIVE", "START"],
    ["ACTIVE", "RESUME"],
    ["ACTIVE", "RECOVER"],
    ["PAUSED", "PAUSE"],
    ["PAUSED", "START"],
    ["PAUSED", "COMPLETE"],
    ["PAUSED", "FAIL"],
    ["PAUSED", "ENTER_COOLDOWN"],
    ["COOLDOWN", "PAUSE"],
    ["COOLDOWN", "START"],
    ["COOLDOWN", "ENTER_COOLDOWN"],
    ["FAILED", "RESUME"],
    ["FAILED", "START"],
    ["FAILED", "PAUSE"],
    ["COMPLETED", "START"],
    ["COMPLETED", "RESUME"],
    ["COMPLETED", "PAUSE"],
    ["STOPPED", "START"],
    ["STOPPED", "STOP"],
    ["STOPPED", "RESUME"],
  ];

  it.each(invalidEdges)("rejects %s + %s", (from, command) => {
    expect(() => transitionWarmupState(from, command)).toThrow(InvalidWarmupTransitionError);
  });

  it("STOPPED is terminal — no command is ever valid from it", () => {
    const commands: WarmupCommand[] = ["START", "PAUSE", "ENTER_COOLDOWN", "RESUME", "COMPLETE", "STOP", "FAIL", "RECOVER"];
    for (const command of commands) {
      expect(() => transitionWarmupState("STOPPED", command)).toThrow(InvalidWarmupTransitionError);
    }
  });

  it("error message names both the current state and the rejected command", () => {
    try {
      transitionWarmupState("COMPLETED", "PAUSE");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWarmupTransitionError);
      const err = error as InvalidWarmupTransitionError;
      expect(err.currentState).toBe("COMPLETED");
      expect(err.command).toBe("PAUSE");
      expect(err.message).toContain("COMPLETED");
      expect(err.message).toContain("PAUSE");
    }
  });
});

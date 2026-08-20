import { describe, expect, it } from "vitest";
import { ACTION_FACT_TYPES, type DomainFactType } from "../../src/modules/conversations/domain/domain-facts.js";
import { computeFactSetHash, evaluatePolicy } from "../../src/modules/conversations/domain/policy-evaluation.js";
import {
  ACTION_POLICY_SIGNAL_TYPES,
  CONVERSATION_POLICY_VERSION,
  isPolicySignalType,
  POLICY_SIGNAL_TYPES,
} from "../../src/modules/conversations/domain/policy-signal-taxonomy.js";

function signalsOf(facts: readonly DomainFactType[]) {
  return evaluatePolicy(facts).signals.map((row) => row.signal);
}

describe("conversation policy evaluation", () => {
  it("exposes the Stage 14 signal taxonomy and rejects action verbs", () => {
    for (const signal of [
      "CONTACT_SUPPRESSION_REQUIRED",
      "TEMPORARY_CONTACT_PAUSE",
      "FOLLOW_UP_OPPORTUNITY",
      "MEETING_REQUESTED",
      "CONTACT_REVIEW_REQUIRED",
      "NEGATIVE_RESPONSE",
      "SPAM_SIGNAL",
      "OUT_OF_OFFICE",
      "REFERRAL_DETECTED",
      "QUESTION_DETECTED",
    ]) {
      expect(POLICY_SIGNAL_TYPES).toContain(signal);
      expect(isPolicySignalType(signal)).toBe(true);
    }
    for (const action of ACTION_POLICY_SIGNAL_TYPES) {
      expect(isPolicySignalType(action)).toBe(false);
    }
    for (const action of ACTION_FACT_TYPES) {
      expect(isPolicySignalType(action)).toBe(false);
    }
  });

  it("maps positive interest plus meeting request to follow-up and meeting signals", () => {
    expect(signalsOf(["POSITIVE_INTEREST", "MEETING_REQUEST"])).toEqual([
      "FOLLOW_UP_OPPORTUNITY",
      "MEETING_REQUESTED",
      "POSITIVE_RESPONSE",
    ]);
  });

  it("lets unsubscribe dominate interest — suppression only, no continue-contacting signal", () => {
    const result = evaluatePolicy(["POSITIVE_INTEREST", "UNSUBSCRIBE"]);
    expect(result.signals.map((row) => row.signal)).toEqual(["CONTACT_SUPPRESSION_REQUIRED"]);
    expect(result.signals[0]?.priority).toBe("CRITICAL");
    expect(result.signals.some((row) => row.signal === "FOLLOW_UP_OPPORTUNITY")).toBe(false);
    expect(result.signals.some((row) => row.signal === "POSITIVE_RESPONSE")).toBe(false);
  });

  it("lets spam dominate and emits suppression plus spam signal", () => {
    expect(signalsOf(["SPAM", "POSITIVE_INTEREST", "MEETING_REQUEST"])).toEqual([
      "CONTACT_SUPPRESSION_REQUIRED",
      "SPAM_SIGNAL",
    ]);
  });

  it("treats OOO as a temporary pause, not suppression", () => {
    const result = evaluatePolicy(["OOO"]);
    expect(signalsOf(["OOO"])).toEqual(["TEMPORARY_CONTACT_PAUSE", "OUT_OF_OFFICE"]);
    expect(result.signals.some((row) => row.signal === "CONTACT_SUPPRESSION_REQUIRED")).toBe(false);
  });

  it("maps meeting request, interest, wrong person, negative, referral, and question", () => {
    expect(signalsOf(["MEETING_REQUEST"])).toEqual(["FOLLOW_UP_OPPORTUNITY", "MEETING_REQUESTED"]);
    expect(signalsOf(["POSITIVE_INTEREST"])).toEqual(["FOLLOW_UP_OPPORTUNITY", "POSITIVE_RESPONSE"]);
    expect(signalsOf(["WRONG_PERSON"])).toEqual(["CONTACT_REVIEW_REQUIRED"]);
    expect(signalsOf(["NEGATIVE_INTEREST"])).toEqual(["NEGATIVE_RESPONSE"]);
    expect(signalsOf(["REFERRAL"])).toEqual(["REFERRAL_DETECTED"]);
    expect(signalsOf(["QUESTION"])).toEqual(["QUESTION_DETECTED"]);
  });

  it("does not emit commercial follow-up when the person is wrong or negative", () => {
    expect(signalsOf(["WRONG_PERSON", "POSITIVE_INTEREST"])).toEqual(["CONTACT_REVIEW_REQUIRED"]);
    expect(signalsOf(["NEGATIVE_INTEREST", "POSITIVE_INTEREST"])).toEqual(["NEGATIVE_RESPONSE"]);
  });

  it("keeps OOO pause over follow-up while still recording a meeting request", () => {
    expect(signalsOf(["OOO", "MEETING_REQUEST", "POSITIVE_INTEREST"])).toEqual([
      "TEMPORARY_CONTACT_PAUSE",
      "MEETING_REQUESTED",
      "OUT_OF_OFFICE",
    ]);
  });

  it("evaluates multi-fact combinations without deleting facts from the input set", () => {
    const facts: DomainFactType[] = ["QUESTION", "REFERRAL", "POSITIVE_INTEREST"];
    expect(signalsOf(facts)).toEqual([
      "FOLLOW_UP_OPPORTUNITY",
      "POSITIVE_RESPONSE",
      "REFERRAL_DETECTED",
      "QUESTION_DETECTED",
    ]);
    expect(facts).toEqual(["QUESTION", "REFERRAL", "POSITIVE_INTEREST"]);
  });

  it("is deterministic across input order and records policy versioning", () => {
    const a = evaluatePolicy(["MEETING_REQUEST", "POSITIVE_INTEREST", "QUESTION"]);
    const b = evaluatePolicy(["QUESTION", "POSITIVE_INTEREST", "MEETING_REQUEST"]);
    expect(a).toEqual(b);
    expect(a.policyVersion).toBe(CONVERSATION_POLICY_VERSION);
    const v2 = evaluatePolicy(["OOO"], { policyVersion: "conversation-policy/v2" });
    expect(v2.policyVersion).toBe("conversation-policy/v2");
    expect(v2.signals.map((row) => row.signal)).toEqual(["TEMPORARY_CONTACT_PAUSE", "OUT_OF_OFFICE"]);
  });

  it("hashes fact sets stably for uniqueness", () => {
    expect(computeFactSetHash(["UNSUBSCRIBE", "POSITIVE_INTEREST"])).toBe(
      computeFactSetHash(["POSITIVE_INTEREST", "UNSUBSCRIBE"]),
    );
    expect(computeFactSetHash(["OOO"])).not.toBe(computeFactSetHash(["UNSUBSCRIBE"]));
  });

  it("does not inspect email text — only fact types", () => {
    const injected = evaluatePolicy(["NEUTRAL" as DomainFactType]);
    expect(injected.signals).toEqual([]);
    expect(evaluatePolicy([])).toEqual(evaluatePolicy(["MESSAGE_RECEIVED"]));
  });
});

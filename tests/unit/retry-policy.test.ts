import { describe, expect, it } from "vitest";
import { classifyRetry, computeBackoffDelay } from "../../src/modules/warmup/domain/retry-policy.js";
import type { ProviderSendResult } from "../../src/modules/warmup/domain/send-result.js";

function result(overrides: Partial<ProviderSendResult> = {}): ProviderSendResult {
  return { status: "TEMPORARY_FAILURE", provider: "GMAIL", timestamp: new Date(), retryable: true, ...overrides };
}

describe("classifyRetry", () => {
  it("retries a TEMPORARY_FAILURE within the attempt budget", () => {
    const decision = classifyRetry(result({ status: "TEMPORARY_FAILURE" }), 0);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it("retries a RATE_LIMITED result within the attempt budget", () => {
    const decision = classifyRetry(result({ status: "RATE_LIMITED" }), 1);
    expect(decision.shouldRetry).toBe(true);
  });

  it("never retries AUTH_FAILED regardless of the provider's own retryable flag", () => {
    const decision = classifyRetry(result({ status: "AUTH_FAILED", retryable: true }), 0);
    expect(decision.shouldRetry).toBe(false);
  });

  it("never retries PERMANENT_FAILURE regardless of the provider's own retryable flag", () => {
    const decision = classifyRetry(result({ status: "PERMANENT_FAILURE", retryable: true }), 0);
    expect(decision.shouldRetry).toBe(false);
  });

  it("never retries ACCEPTED (nothing to retry)", () => {
    const decision = classifyRetry(result({ status: "ACCEPTED" }), 0);
    expect(decision.shouldRetry).toBe(false);
  });

  it("respects the provider's own retryable=false even for an otherwise-retryable status", () => {
    const decision = classifyRetry(result({ status: "TEMPORARY_FAILURE", retryable: false }), 0);
    expect(decision.shouldRetry).toBe(false);
  });

  it("stops retrying once the maximum attempt count is reached", () => {
    const decision = classifyRetry(result({ status: "TEMPORARY_FAILURE" }), 5);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toMatch(/maximum attempts/i);
  });

  it("is bounded — never retries indefinitely as attemptCount grows", () => {
    for (let attempt = 5; attempt < 50; attempt++) {
      expect(classifyRetry(result({ status: "TEMPORARY_FAILURE" }), attempt).shouldRetry).toBe(false);
    }
  });
});

describe("computeBackoffDelay", () => {
  it("is deterministic for a fixed random() input", () => {
    const a = computeBackoffDelay(2, () => 0.5);
    const b = computeBackoffDelay(2, () => 0.5);
    expect(a).toBe(b);
  });

  it("grows with attempt number", () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) => computeBackoffDelay(attempt, () => 0));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });

  it("is capped — does not grow unboundedly for large attempt numbers", () => {
    const delayAt10 = computeBackoffDelay(10, () => 1);
    const delayAt30 = computeBackoffDelay(30, () => 1);
    expect(delayAt30).toBe(delayAt10);
  });

  it("jitter stays within the documented [cap/2, cap] window, never collapsing to zero", () => {
    const low = computeBackoffDelay(3, () => 0);
    const high = computeBackoffDelay(3, () => 1);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it("prevents perfectly synchronized retries — different random() draws produce different delays", () => {
    const delayA = computeBackoffDelay(3, () => 0.1);
    const delayB = computeBackoffDelay(3, () => 0.9);
    expect(delayA).not.toBe(delayB);
  });
});

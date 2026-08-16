import { describe, expect, it } from "vitest";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { asTenantId, asWarmupSessionId } from "../../src/shared/types/index.js";

describe("computeIdempotencyKey", () => {
  const tenantId = asTenantId("11111111-1111-1111-1111-111111111111");
  const sessionId = asWarmupSessionId("22222222-2222-2222-2222-222222222222");

  it("is deterministic for the same inputs", () => {
    const a = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 0 });
    const b = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 0 });
    expect(a).toBe(b);
  });

  it("differs when warmupDay differs", () => {
    const a = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 0 });
    const b = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 4, executionSlot: 0 });
    expect(a).not.toBe(b);
  });

  it("differs when executionSlot differs", () => {
    const a = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 0 });
    const b = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 1 });
    expect(a).not.toBe(b);
  });

  it("differs when sessionId differs", () => {
    const otherSession = asWarmupSessionId("33333333-3333-3333-3333-333333333333");
    const a = computeIdempotencyKey({ tenantId, sessionId, warmupDay: 3, executionSlot: 0 });
    const b = computeIdempotencyKey({ tenantId, sessionId: otherSession, warmupDay: 3, executionSlot: 0 });
    expect(a).not.toBe(b);
  });
});

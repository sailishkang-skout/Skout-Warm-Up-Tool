import { describe, expect, it } from "vitest";
import {
  getRequestContext,
  requireRequestContext,
  runWithRequestContext,
} from "../../src/shared/observability/index.js";
import { asCorrelationId, asRequestId } from "../../src/shared/types/index.js";
import type { RequestContext } from "../../src/shared/types/index.js";

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: asRequestId("req-1"),
    correlationId: asCorrelationId("corr-1"),
    ...overrides,
  };
}

describe("request context storage", () => {
  it("returns undefined outside of any context", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("throws from requireRequestContext outside of any context", () => {
    expect(() => requireRequestContext()).toThrow();
  });

  it("makes the context available to synchronous code inside runWithRequestContext", () => {
    const context = makeContext();
    const observed = runWithRequestContext(context, () => getRequestContext());
    expect(observed).toBe(context);
  });

  it("propagates through async/await within the same call", async () => {
    const context = makeContext({ requestId: asRequestId("req-async") });

    async function nested(): Promise<RequestContext | undefined> {
      await Promise.resolve();
      return getRequestContext();
    }

    const observed = await runWithRequestContext(context, () => nested());
    expect(observed).toBe(context);
  });

  it("does not leak context outside of the call it was scoped to", () => {
    runWithRequestContext(makeContext(), () => {
      // context is established and torn down entirely within this callback
    });
    expect(getRequestContext()).toBeUndefined();
  });

  it("keeps two concurrent contexts isolated from each other", async () => {
    const contextA = makeContext({ requestId: asRequestId("req-a") });
    const contextB = makeContext({ requestId: asRequestId("req-b") });

    async function readAfterDelay(delayMs: number): Promise<string | undefined> {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return getRequestContext()?.requestId;
    }

    const [resultA, resultB] = await Promise.all([
      runWithRequestContext(contextA, () => readAfterDelay(10)),
      runWithRequestContext(contextB, () => readAfterDelay(1)),
    ]);

    expect(resultA).toBe("req-a");
    expect(resultB).toBe("req-b");
  });
});

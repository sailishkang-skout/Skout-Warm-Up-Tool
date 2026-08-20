import { describe, expect, it } from "vitest";
import {
  classifyProviderHttpStatus,
  classifyProviderTransportError,
  retryAfterDelayMs,
} from "../../src/modules/providers/domain/provider-failure.js";

describe("classifyProviderHttpStatus", () => {
  it("does not retry authentication or authorization failures", () => {
    expect(classifyProviderHttpStatus(401)).toEqual({
      category: "AUTHENTICATION_ERROR",
      retryable: false,
      httpStatus: 401,
    });
    expect(classifyProviderHttpStatus(403)).toEqual({
      category: "AUTHORIZATION_ERROR",
      retryable: false,
      httpStatus: 403,
    });
  });

  it("retries 429 and 5xx, honoring Retry-After when present", () => {
    expect(classifyProviderHttpStatus(429).retryable).toBe(true);
    expect(classifyProviderHttpStatus(503).category).toBe("TEMPORARY_PROVIDER_ERROR");
    expect(retryAfterDelayMs("2", () => 0)).toBe(2000);
  });

  it("classifies timeouts as retryable", () => {
    expect(classifyProviderTransportError(new DOMException("The operation was aborted.", "TimeoutError"))).toMatchObject({
      category: "TIMEOUT",
      retryable: true,
    });
  });
});

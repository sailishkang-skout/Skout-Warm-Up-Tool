import { describe, expect, it } from "vitest";
import { classifyCredentialLifecycle } from "../../src/modules/providers/domain/credential-lifecycle.js";

describe("classifyCredentialLifecycle", () => {
  it("treats a missing stored credential as PENDING", () => {
    expect(classifyCredentialLifecycle({})).toBe("PENDING");
  });

  it("maps EXPIRED storage to REFRESH_REQUIRED", () => {
    expect(classifyCredentialLifecycle({ storedStatus: "EXPIRED" })).toBe("REFRESH_REQUIRED");
  });

  it("marks an ACTIVE credential EXPIRING within 24h", () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    expect(
      classifyCredentialLifecycle({
        storedStatus: "ACTIVE",
        expiresAt: new Date("2026-08-20T18:00:00.000Z"),
        now,
      }),
    ).toBe("EXPIRING");
  });
});

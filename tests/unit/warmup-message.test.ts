import { describe, expect, it } from "vitest";
import { generateWarmupMessage } from "../../src/modules/warmup/domain/warmup-message.js";

describe("generateWarmupMessage", () => {
  it("addresses the message to the sending mailbox itself (self-send)", () => {
    const message = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-1" });
    expect(message.to).toBe("alice@example.com");
  });

  it("is deterministic — the same idempotencyKey always produces the same content", () => {
    const a = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-1" });
    const b = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-1" });
    expect(a).toEqual(b);
  });

  it("produces different content for a different idempotencyKey", () => {
    const a = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-1" });
    const b = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-2" });
    expect(a.subject).not.toBe(b.subject);
    expect(a.body).not.toBe(b.body);
  });

  it("never includes tenant/session/mailbox ids or any other identifying detail beyond the address itself", () => {
    const key = "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:3:0";
    const message = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: key });
    expect(message.subject).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(message.body).not.toContain("22222222-2222-2222-2222-222222222222");
  });

  it("is short, generic, and non-promotional", () => {
    const message = generateWarmupMessage({ fromAddress: "alice@example.com", idempotencyKey: "key-1" });
    expect(message.subject.length).toBeLessThan(60);
    expect(message.body.length).toBeLessThan(300);
    expect(message.body.toLowerCase()).not.toMatch(/buy|sale|offer|discount|click here/);
  });
});

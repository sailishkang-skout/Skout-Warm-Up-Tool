import { describe, expect, it } from "vitest";
import { computeSyntheticThreadKey } from "../../src/modules/conversations/domain/conversation.js";
import { computeMessageDedupeKey, TEXT_BODY_MAX_BYTES, truncateTextBody } from "../../src/modules/conversations/domain/conversation-message.js";
import { asMailboxId, asTenantId } from "../../src/shared/types/index.js";

const tenantId = asTenantId("11111111-1111-1111-1111-111111111111");
const mailboxId = asMailboxId("22222222-2222-2222-2222-222222222222");

describe("conversation identity helpers", () => {
  it("prefers provider thread id for the synthetic key", () => {
    expect(computeSyntheticThreadKey({ provider: "GMAIL", providerThreadId: "t1", providerMessageId: "m1" })).toBe(
      "gmail-thread:t1",
    );
  });

  it("does not emit a fallback dedupe key when a provider message id exists", () => {
    expect(
      computeMessageDedupeKey({
        tenantId,
        mailboxId,
        provider: "GMAIL",
        direction: "INBOUND",
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
        sender: "a@b.com",
        providerMessageId: "gmail-1",
      }),
    ).toBeUndefined();
  });

  it("emits a stable fallback dedupe key when both ids are missing", () => {
    const sentAt = new Date("2026-01-01T00:00:00.000Z");
    const first = computeMessageDedupeKey({
      tenantId,
      mailboxId,
      provider: "MICROSOFT365",
      direction: "OUTBOUND",
      sentAt,
      sender: "me@x.com",
      subject: "Warmup",
    });
    const second = computeMessageDedupeKey({
      tenantId,
      mailboxId,
      provider: "MICROSOFT365",
      direction: "OUTBOUND",
      sentAt,
      sender: "me@x.com",
      subject: "Warmup",
    });
    expect(first).toMatch(/^fallback:/);
    expect(first).toBe(second);
  });

  it("truncates text bodies to 64 KiB", () => {
    const oversized = "a".repeat(TEXT_BODY_MAX_BYTES + 50);
    const truncated = truncateTextBody(oversized);
    expect(Buffer.byteLength(truncated!, "utf8")).toBe(TEXT_BODY_MAX_BYTES);
  });
});

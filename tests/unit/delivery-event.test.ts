import { describe, expect, it } from "vitest";
import { computeDeliveryEventDedupeKey } from "../../src/modules/delivery-events/domain/delivery-event.js";
import { asMailboxId, asTenantId, asWarmupExecutionIntentId } from "../../src/shared/types/index.js";

const TENANT_ID = asTenantId("11111111-1111-1111-1111-111111111111");
const MAILBOX_ID = asMailboxId("22222222-2222-2222-2222-222222222222");
const INTENT_ID = asWarmupExecutionIntentId("33333333-3333-3333-3333-333333333333");
const OBSERVED_AT = new Date("2026-01-01T12:00:00.000Z");

describe("computeDeliveryEventDedupeKey", () => {
  it("is deterministic — the same input always produces the same key", () => {
    const input = { tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL" as const, providerEventId: "evt-1", eventType: "DELIVERED" as const, observedAt: OBSERVED_AT };
    expect(computeDeliveryEventDedupeKey(input)).toBe(computeDeliveryEventDedupeKey(input));
  });

  it("uses tenant + provider + providerEventId when a provider event id is supplied — ignores everything else", () => {
    const withDifferentMailbox = computeDeliveryEventDedupeKey({
      tenantId: TENANT_ID,
      mailboxId: MAILBOX_ID,
      provider: "GMAIL",
      providerEventId: "evt-1",
      eventType: "DELIVERED",
      observedAt: OBSERVED_AT,
    });
    const withDifferentEventType = computeDeliveryEventDedupeKey({
      tenantId: TENANT_ID,
      mailboxId: asMailboxId("99999999-9999-9999-9999-999999999999"),
      provider: "GMAIL",
      providerEventId: "evt-1",
      eventType: "BOUNCED",
      observedAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(withDifferentMailbox).toBe(withDifferentEventType);
  });

  it("different providerEventId values produce different keys even with everything else identical", () => {
    const a = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", providerEventId: "evt-1", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    const b = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", providerEventId: "evt-2", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    expect(a).not.toBe(b);
  });

  it("different tenants with the same providerEventId never collide", () => {
    const a = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", providerEventId: "evt-1", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    const otherTenant = asTenantId("99999999-9999-9999-9999-999999999999");
    const b = computeDeliveryEventDedupeKey({ tenantId: otherTenant, mailboxId: MAILBOX_ID, provider: "GMAIL", providerEventId: "evt-1", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    expect(a).not.toBe(b);
  });

  it("falls back to tenant+mailbox+provider+eventType+executionIntent+observedAt when no providerEventId exists", () => {
    const input = { tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL" as const, eventType: "BOUNCED" as const, observedAt: OBSERVED_AT, executionIntentId: INTENT_ID };
    const key = computeDeliveryEventDedupeKey(input);
    expect(key).not.toContain("event:");
    expect(key).toContain("fallback:");
  });

  it("fallback keys differ when observedAt differs, even with everything else identical", () => {
    const a = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", eventType: "BOUNCED", observedAt: OBSERVED_AT });
    const b = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", eventType: "BOUNCED", observedAt: new Date(OBSERVED_AT.getTime() + 1) });
    expect(a).not.toBe(b);
  });

  it("a providerEventId key and a fallback key for equivalent-looking events never accidentally collide", () => {
    const withId = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", providerEventId: "evt-1", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    const withoutId = computeDeliveryEventDedupeKey({ tenantId: TENANT_ID, mailboxId: MAILBOX_ID, provider: "GMAIL", eventType: "DELIVERED", observedAt: OBSERVED_AT });
    expect(withId).not.toBe(withoutId);
  });
});

import { describe, expect, it } from "vitest";
import { ACTION_FACT_TYPES } from "../../src/modules/conversations/domain/domain-facts.js";
import {
  CRM_CONSUMER_EVENT_TYPES,
  SEQUENCE_CONSUMER_EVENT_TYPES,
  SUPPRESSION_CONSUMER_EVENT_TYPES,
} from "../../src/modules/conversations/domain/integration-event.js";
import {
  INTEGRATION_CONTRACT_VERSION,
  INTEGRATION_ENTITY_TYPE,
  INTEGRATION_EVENT_SOURCE,
  INTEGRATION_EVENTS_MAX_PAGE_SIZE,
  isKnownIntegrationEventType,
  sliceIntegrationEventPage,
  toIntegrationEventConsumerRecord,
  toIntegrationEventListResponse,
} from "../../src/modules/conversations/application/integration-event-consumption.js";
import {
  computeIntegrationIdempotencyKey,
  integrationEventTypeForSignal,
  mapPolicySignalToIntegrationEvent,
  sanitizeIntegrationPayload,
} from "../../src/modules/conversations/domain/integration-event-mapping.js";
import {
  ACTION_INTEGRATION_EVENT_TYPES,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_EVENT_VERSION,
  isIntegrationEventType,
} from "../../src/modules/conversations/domain/integration-event-taxonomy.js";
import { evaluatePolicy } from "../../src/modules/conversations/domain/policy-evaluation.js";
import { ACTION_POLICY_SIGNAL_TYPES } from "../../src/modules/conversations/domain/policy-signal-taxonomy.js";
import { asConversationId, asMailboxId, asMessageId, asTenantId } from "../../src/shared/types/index.js";

const tenantId = asTenantId("11111111-1111-4111-8111-111111111111");
const conversationId = asConversationId("22222222-2222-4222-8222-222222222222");
const messageId = asMessageId("33333333-3333-4333-8333-333333333333");

describe("integration event contract", () => {
  it("defines a provider-neutral envelope taxonomy and rejects action events", () => {
    expect(INTEGRATION_EVENT_TYPES).toEqual([
      "CONVERSATION_UPDATED",
      "MESSAGE_RECEIVED",
      "MESSAGE_SENT",
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
    ]);
    expect(INTEGRATION_EVENT_VERSION).toBe(1);
    for (const action of ACTION_INTEGRATION_EVENT_TYPES) {
      expect(isIntegrationEventType(action)).toBe(false);
    }
    for (const action of ACTION_POLICY_SIGNAL_TYPES) {
      expect(isIntegrationEventType(action)).toBe(false);
    }
    for (const action of ACTION_FACT_TYPES) {
      expect(isIntegrationEventType(action)).toBe(false);
    }
  });

  it("builds an envelope with version, tenant, and idempotency key", () => {
    const event = mapPolicySignalToIntegrationEvent({
      tenantId,
      conversationId,
      messageId,
      policySignalId: "44444444-4444-4444-8444-444444444444",
      signal: "CONTACT_SUPPRESSION_REQUIRED",
      priority: "CRITICAL",
      sourceFactType: "UNSUBSCRIBE",
      sourceFactId: "fact-1",
      policyVersion: "conversation-policy/v1",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
      contactIdentifier: "lead@example.com",
    });
    expect(event).toBeDefined();
    expect(event?.eventType).toBe("CONTACT_SUPPRESSION_REQUIRED");
    expect(event?.eventVersion).toBe(1);
    expect(event?.tenantId).toBe(tenantId);
    expect(event?.source).toBe(INTEGRATION_EVENT_SOURCE);
    expect(event?.conversationId).toBe(conversationId);
    expect(event?.messageId).toBe(messageId);
    expect(event?.policyVersion).toBe("conversation-policy/v1");
    expect(event?.sourceFactId).toBe("fact-1");
    expect(event?.sourcePolicySignalId).toBe("44444444-4444-4444-8444-444444444444");
    expect(event?.idempotencyKey).toBe(
      computeIntegrationIdempotencyKey({
        tenantId,
        policySignalId: "44444444-4444-4444-8444-444444444444",
        eventType: "CONTACT_SUPPRESSION_REQUIRED",
        eventVersion: 1,
      }),
    );
    expect(event?.payload).toMatchObject({
      tenantId,
      conversationId,
      messageId,
      contactIdentifier: "lead@example.com",
      reason: "UNSUBSCRIBE",
      sourceFactId: "fact-1",
      policyVersion: "conversation-policy/v1",
      occurredAt: "2026-01-02T03:04:05.000Z",
      priority: "CRITICAL",
    });
    expect(event?.payload).not.toHaveProperty("mailboxId");
    expect(event?.payload).not.toHaveProperty("source");
  });

  it("is stable for the same policy signal and integration version", () => {
    const a = computeIntegrationIdempotencyKey({
      tenantId,
      policySignalId: "sig-1",
      eventType: "NEGATIVE_RESPONSE",
      eventVersion: 1,
    });
    const b = computeIntegrationIdempotencyKey({
      tenantId,
      policySignalId: "sig-1",
      eventType: "NEGATIVE_RESPONSE",
      eventVersion: 1,
    });
    expect(a).toBe(b);
    expect(
      computeIntegrationIdempotencyKey({
        tenantId,
        policySignalId: "sig-1",
        eventType: "NEGATIVE_RESPONSE",
        eventVersion: 2,
      }),
    ).not.toBe(a);
  });

  it("keeps tenant identity on the envelope and does not mix tenants in the key", () => {
    const other = asTenantId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const mine = computeIntegrationIdempotencyKey({
      tenantId,
      policySignalId: "sig-1",
      eventType: "QUESTION_DETECTED",
      eventVersion: 1,
    });
    const theirs = computeIntegrationIdempotencyKey({
      tenantId: other,
      policySignalId: "sig-1",
      eventType: "QUESTION_DETECTED",
      eventVersion: 1,
    });
    expect(mine).not.toBe(theirs);
  });

  it("strips bodies, tokens, prompts, and redacts remaining sensitive keys", () => {
    const sanitized = sanitizeIntegrationPayload({
      reason: "UNSUBSCRIBE",
      textBody: "please unsubscribe",
      htmlBody: "<p>secret</p>",
      prompt: "classify this",
      access_token: "tok",
      Authorization: "Bearer x",
      rawProviderPayload: { id: 1 },
      apiKey: "k",
    });
    expect(sanitized).not.toHaveProperty("textBody");
    expect(sanitized).not.toHaveProperty("htmlBody");
    expect(sanitized).not.toHaveProperty("prompt");
    expect(sanitized).not.toHaveProperty("access_token");
    expect(sanitized).not.toHaveProperty("Authorization");
    expect(sanitized).not.toHaveProperty("rawProviderPayload");
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.reason).toBe("UNSUBSCRIBE");
  });

  it("maps policy signals to integration events and skips POSITIVE_RESPONSE", () => {
    expect(integrationEventTypeForSignal("CONTACT_SUPPRESSION_REQUIRED")).toBe("CONTACT_SUPPRESSION_REQUIRED");
    expect(integrationEventTypeForSignal("POSITIVE_RESPONSE")).toBeUndefined();
    expect(
      mapPolicySignalToIntegrationEvent({
        tenantId,
        conversationId,
        policySignalId: "sig-pos",
        signal: "POSITIVE_RESPONSE",
        priority: "MEDIUM",
        sourceFactType: "POSITIVE_INTEREST",
        policyVersion: "conversation-policy/v1",
        occurredAt: new Date(),
      }),
    ).toBeUndefined();
  });

  it("lets unsubscribe dominate interest — suppression event only, no action event", () => {
    const signals = evaluatePolicy(["UNSUBSCRIBE", "POSITIVE_INTEREST"]).signals;
    const events = signals
      .map((row) =>
        mapPolicySignalToIntegrationEvent({
          tenantId,
          conversationId,
          messageId,
          policySignalId: `sig-${row.signal}`,
          signal: row.signal,
          priority: row.priority,
          sourceFactType: row.sourceFactType,
          policyVersion: "conversation-policy/v1",
          occurredAt: new Date(),
        }),
      )
      .filter((event) => event !== undefined);
    expect(events.map((event) => event.eventType)).toEqual(["CONTACT_SUPPRESSION_REQUIRED"]);
    expect(events.some((event) => ACTION_INTEGRATION_EVENT_TYPES.includes(event.eventType as never))).toBe(false);
    expect(SUPPRESSION_CONSUMER_EVENT_TYPES).toContain("CONTACT_SUPPRESSION_REQUIRED");
    expect(SEQUENCE_CONSUMER_EVENT_TYPES).toContain("FOLLOW_UP_OPPORTUNITY");
    expect(CRM_CONSUMER_EVENT_TYPES).toContain("MEETING_REQUESTED");
  });

  it("exposes schemaVersion and entity identity without inferring version from eventType", () => {
    const event = mapPolicySignalToIntegrationEvent({
      tenantId,
      conversationId,
      policySignalId: "55555555-5555-4555-8555-555555555555",
      signal: "OUT_OF_OFFICE",
      priority: "MEDIUM",
      sourceFactType: "OOO",
      policyVersion: "conversation-policy/v1",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
      mailboxId: asMailboxId("77777777-7777-4777-8777-777777777777"),
    });
    expect(event).toBeDefined();
    const withCreated = { ...event!, createdAt: "2026-01-02T03:05:00.000Z" };
    const record = toIntegrationEventConsumerRecord(withCreated);
    expect(record.schemaVersion).toBe(INTEGRATION_EVENT_VERSION);
    expect(record.schemaVersion).toBe(event!.eventVersion);
    expect(record.createdAt).toBe("2026-01-02T03:05:00.000Z");
    expect(record.source).toBe(INTEGRATION_EVENT_SOURCE);
    expect(record.mailboxId).toBe("77777777-7777-4777-8777-777777777777");
    expect(record.entityType).toBe(INTEGRATION_ENTITY_TYPE);
    expect(record.entityId).toBe(conversationId);
    expect(record.eventId).toBe(event!.eventId);
    expect(INTEGRATION_EVENTS_MAX_PAGE_SIZE).toBe(100);
  });

  it("slices pages so a full page can advertise continuation without skipping", () => {
    const event = mapPolicySignalToIntegrationEvent({
      tenantId,
      conversationId,
      policySignalId: "66666666-6666-4666-8666-666666666666",
      signal: "QUESTION_DETECTED",
      priority: "LOW",
      sourceFactType: "QUESTION",
      policyVersion: "conversation-policy/v1",
      occurredAt: new Date(),
    });
    expect(event).toBeDefined();
    const rows = [event!, event!, event!];
    expect(sliceIntegrationEventPage(rows, 2)).toEqual({ events: [event!, event!], hasMore: true });
    expect(sliceIntegrationEventPage(rows.slice(0, 2), 2)).toEqual({ events: [event!, event!], hasMore: false });
  });

  it("keeps unknown future event types on the page so consumers can checkpoint eventId", () => {
    const event = mapPolicySignalToIntegrationEvent({
      tenantId,
      conversationId,
      policySignalId: "88888888-8888-4888-8888-888888888888",
      signal: "QUESTION_DETECTED",
      priority: "LOW",
      sourceFactType: "QUESTION",
      policyVersion: "conversation-policy/v1",
      occurredAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(event).toBeDefined();
    const future = {
      ...event!,
      eventType: "FUTURE_SIGNAL",
      eventVersion: 2,
      createdAt: "2026-01-02T03:06:00.000Z",
    };
    expect(isKnownIntegrationEventType(future.eventType)).toBe(false);
    expect(isKnownIntegrationEventType("CONTACT_SUPPRESSION_REQUIRED")).toBe(true);
    const record = toIntegrationEventConsumerRecord(future);
    expect(record.eventType).toBe("FUTURE_SIGNAL");
    expect(record.schemaVersion).toBe(2);
    expect(record.eventId).toBe(event!.eventId);
    const listed = toIntegrationEventListResponse({ events: [future], hasMore: false });
    expect(listed.contractVersion).toBe(INTEGRATION_CONTRACT_VERSION);
    expect(listed.events[0]?.eventType).toBe("FUTURE_SIGNAL");
    expect(listed.hasMore).toBe(false);
    expect(listed.nextCursor).toBeUndefined();
  });
});

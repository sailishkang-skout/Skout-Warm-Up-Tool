import { randomUUID } from "node:crypto";
import { sanitizeForLogging } from "../../../shared/logger/index.js";
import {
  asConversationId,
  asIntegrationEventId,
  asMailboxId,
  asMessageId,
  asTenantId,
  asWarmupExecutionIntentId,
  type ConversationId,
  type MailboxId,
  type MessageId,
  type TenantId,
  type WarmupExecutionIntentId,
} from "../../../shared/types/index.js";
import type { DomainFactType } from "./domain-facts.js";
import type { IntegrationEventEnvelope, IntegrationEventPayload } from "./integration-event.js";
import {
  INTEGRATION_EVENT_SOURCE,
  INTEGRATION_EVENT_VERSION,
  isIntegrationEventType,
  POLICY_SIGNAL_INTEGRATION_EVENTS,
  type IntegrationEventType,
} from "./integration-event-taxonomy.js";
import type { PolicySignalPriority, PolicySignalType } from "./policy-signal-taxonomy.js";

const FORBIDDEN_PAYLOAD_KEYS =
  /(body|html|prompt|model|credential|token|authorization|password|secret|header|raw)/i;

export interface PolicySignalIntegrationInput {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly messageId?: MessageId;
  readonly policySignalId: string;
  readonly signal: PolicySignalType;
  readonly priority: PolicySignalPriority;
  readonly sourceFactType?: DomainFactType;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly occurredAt: Date;
  readonly contactIdentifier?: string;
  readonly mailboxId?: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly eventVersion?: number;
}

export function integrationEventTypeForSignal(signal: PolicySignalType): IntegrationEventType | undefined {
  if ((POLICY_SIGNAL_INTEGRATION_EVENTS as readonly string[]).includes(signal)) {
    return signal as IntegrationEventType;
  }
  return undefined;
}

export function computeIntegrationIdempotencyKey(input: {
  readonly tenantId: string;
  readonly policySignalId: string;
  readonly eventType: IntegrationEventType;
  readonly eventVersion: number;
}): string {
  return `${input.tenantId}:${input.policySignalId}:${input.eventType}:v${input.eventVersion}`;
}

export function sanitizeIntegrationPayload(value: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PAYLOAD_KEYS.test(key)) {
      continue;
    }
    stripped[key] = entry;
  }
  return sanitizeForLogging(stripped) as Record<string, unknown>;
}

function optionalContact(identifier: string | undefined): string | undefined {
  if (!identifier) {
    return undefined;
  }
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > 320) {
    return undefined;
  }
  return trimmed;
}

function buildPolicyPayload(input: PolicySignalIntegrationInput, occurredAt: string): IntegrationEventPayload {
  const contactIdentifier = optionalContact(input.contactIdentifier);
  const base = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(contactIdentifier ? { contactIdentifier } : {}),
    reason: input.sourceFactType ?? input.signal,
    ...(input.sourceFactId ? { sourceFactId: input.sourceFactId } : {}),
    policyVersion: input.policyVersion,
    occurredAt,
    priority: input.priority,
  };
  return sanitizeIntegrationPayload(base) as unknown as IntegrationEventPayload;
}

export function mapPolicySignalToIntegrationEvent(
  input: PolicySignalIntegrationInput,
): IntegrationEventEnvelope | undefined {
  const eventType = integrationEventTypeForSignal(input.signal);
  if (!eventType || !isIntegrationEventType(eventType)) {
    return undefined;
  }
  const eventVersion = input.eventVersion ?? INTEGRATION_EVENT_VERSION;
  const occurredAt = input.occurredAt.toISOString();
  const payload = buildPolicyPayload(input, occurredAt);
  return {
    eventId: asIntegrationEventId(randomUUID()),
    eventType,
    eventVersion,
    tenantId: asTenantId(input.tenantId),
    source: INTEGRATION_EVENT_SOURCE,
    conversationId: asConversationId(input.conversationId),
    ...(input.messageId ? { messageId: asMessageId(input.messageId) } : {}),
    ...(input.mailboxId ? { mailboxId: asMailboxId(input.mailboxId) } : {}),
    ...(input.executionIntentId ? { executionIntentId: asWarmupExecutionIntentId(input.executionIntentId) } : {}),
    occurredAt,
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    ...(input.sourceFactId ? { sourceFactId: input.sourceFactId } : {}),
    sourcePolicySignalId: input.policySignalId,
    payload,
    idempotencyKey: computeIntegrationIdempotencyKey({
      tenantId: input.tenantId,
      policySignalId: input.policySignalId,
      eventType,
      eventVersion,
    }),
  };
}

import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { DeliveryEventId, MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";

/**
 * Provider-independent, normalized outcome of one delivery-related signal
 * (Stage 10 spec section 2). `UNKNOWN` is a first-class member, not an
 * error fallback: a provider may report `ACCEPTED`/`SENT` at send time
 * (see `providers/domain/send-message.ts`) while the later delivery
 * outcome genuinely never becomes knowable — that is `UNKNOWN`, never
 * fabricated as `FAILED` or silently dropped.
 */
export const DELIVERY_EVENT_TYPES = [
  "DELIVERED",
  "BOUNCED",
  "FAILED",
  "THROTTLED",
  "DEFERRED",
  "REJECTED",
  "COMPLAINT",
  "UNKNOWN",
] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/**
 * Where this event actually came from — kept open-ended (like
 * `AuditEventType`) rather than a small closed set, since a real provider
 * webhook/poll source is later work (Stage 10 spec section 5's documented
 * fallback: only the authenticated internal ingestion path exists today).
 */
export const DELIVERY_EVENT_SOURCES = ["INTERNAL_API", "WEBHOOK", "POLL", "MANUAL"] as const;
export type DeliveryEventSource = (typeof DELIVERY_EVENT_SOURCES)[number];

/**
 * `metadata` must only ever hold safe, structural detail (Stage 10 spec
 * section 2/22) — never an access/refresh token, an Authorization header,
 * a password, a full provider response body, or an email body. This is a
 * caller-enforced convention (like `health`'s `Evidence.metadata`), backed
 * by the same `sanitizeForLogging` defense-in-depth pattern audit events
 * already use.
 */
export interface DeliveryEvent {
  readonly id: DeliveryEventId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly provider: MailboxProviderType;
  readonly providerEventId?: string;
  readonly eventType: DeliveryEventType;
  readonly observedAt: Date;
  readonly source: DeliveryEventSource;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface DedupeKeyInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly providerEventId?: string;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly eventType: DeliveryEventType;
  readonly observedAt: Date;
}

/**
 * Deterministic and side-effect-free (Stage 10 spec section 3) — the
 * column this codebase enforces uniqueness on, mirroring
 * `warmup/domain/warmup-execution-intent.ts`'s `computeIdempotencyKey`.
 *
 * When a provider supplies its own event id, that alone identifies the
 * event (`tenant + provider + providerEventId` — Stage 10 spec section 3's
 * primary recommendation): the safest possible identity, since the
 * provider itself guarantees it's stable across redelivery.
 *
 * When no `providerEventId` exists (documented limitation — Stage 10 spec
 * section 3: "If providerEventId does not exist, use the safest available
 * deterministic identity and document the limitation"), this falls back to
 * `tenant + mailbox + executionIntent + provider + eventType + observedAt`.
 * That fallback **cannot** distinguish two genuinely independent events
 * that share every one of those fields at exactly the same instant — a
 * real limitation of ingesting events with no provider-native identity,
 * not a bug. Millisecond-precision `observedAt` makes a true collision
 * vanishingly unlikely in practice, but it is not impossible.
 */
export function computeDeliveryEventDedupeKey(input: DedupeKeyInput): string {
  if (input.providerEventId) {
    return `event:${input.tenantId}:${input.provider}:${input.providerEventId}`;
  }
  return `fallback:${input.tenantId}:${input.mailboxId}:${input.provider}:${input.eventType}:${input.executionIntentId ?? "none"}:${input.observedAt.toISOString()}`;
}

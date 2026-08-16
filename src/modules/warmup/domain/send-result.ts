import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

/**
 * Normalized outcome of one provider send attempt (Stage 8 spec section
 * 19) — the shape every `WarmupSendProvider` implementation must return,
 * regardless of which real provider (or lack of one) is behind it.
 * `retryable` is the single source of truth `application/retry-policy.ts`
 * reads; it is never re-derived from `status` by a second lookup table
 * elsewhere, since the provider that produced the result is best placed to
 * know whether it was transient.
 */
export const PROVIDER_SEND_STATUSES = [
  "ACCEPTED",
  "RATE_LIMITED",
  "AUTH_FAILED",
  "TEMPORARY_FAILURE",
  "PERMANENT_FAILURE",
  /**
   * The provider's actual receipt of the send request could not be
   * confirmed (a network failure or timeout after the request may have
   * already left this process) — Stage 9 spec section 7. Deliberately
   * excluded from `retry-policy.ts`'s retryable set: neither Gmail nor
   * Microsoft Graph expose a client-supplied idempotency token, so a retry
   * here could send a genuine duplicate. See docs/ARCHITECTURE.md's
   * idempotency section for the full limitation and what this status
   * requires (manual reconciliation, never an automatic retry).
   */
  "SEND_UNKNOWN",
] as const;
export type ProviderSendStatus = (typeof PROVIDER_SEND_STATUSES)[number];

/**
 * `safeReason` must never contain a raw provider error body, an
 * Authorization header, or any credential/token material (Stage 8 spec
 * section 19/34) — same "safe, structural detail only" rule Stage 7's
 * `Evidence.metadata` follows.
 */
export interface ProviderSendResult {
  readonly status: ProviderSendStatus;
  readonly provider: MailboxProviderType;
  readonly providerMessageId?: string;
  readonly timestamp: Date;
  readonly retryable: boolean;
  readonly safeReason?: string;
}

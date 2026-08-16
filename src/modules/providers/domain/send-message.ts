/**
 * The provider-layer send outcome vocabulary — deliberately its own type,
 * not an import of `warmup`'s `ProviderSendResult` (`send-result.ts`),
 * even though the values happen to coincide today. Dependency direction in
 * this codebase is `warmup → providers`, never the reverse (see
 * docs/ARCHITECTURE.md); `providers` must stay usable by any future caller
 * without knowing `warmup` exists. `warmup`'s infrastructure layer
 * (`infrastructure/adapter-warmup-send-provider.ts`) is what translates
 * this into its own domain type — that translation is the whole point of
 * the boundary Stage 9 spec section 2 draws.
 *
 * `SEND_UNKNOWN` exists because neither Gmail's API nor Microsoft Graph's
 * `sendMail` action expose a client-supplied idempotency token — a
 * network failure or timeout after the request left this process cannot be
 * distinguished from one before it arrived at the provider. Never treat
 * `SEND_UNKNOWN` as retryable; see docs/ARCHITECTURE.md's idempotency
 * section for the full limitation.
 */
export const PROVIDER_SEND_OUTCOME_STATUSES = [
  "ACCEPTED",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "TEMPORARY_FAILURE",
  "PERMANENT_FAILURE",
  "SEND_UNKNOWN",
] as const;
export type ProviderSendOutcomeStatus = (typeof PROVIDER_SEND_OUTCOME_STATUSES)[number];

/**
 * The smallest input a provider adapter needs to send a legitimate,
 * low-risk message (Stage 9 spec section 6/13) — no attachments, no
 * arbitrary headers, no campaign/marketing fields. `from` is included
 * explicitly rather than derived from the credential, since a credential
 * carries no reliable mailbox address of its own.
 */
export interface SendMessageCommand {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * `safeReason` must never contain a raw provider response body, an
 * Authorization header, or any credential/token material (Stage 9 spec
 * section 2/17) — same rule `ProviderConnectionValidationResult.message`
 * and `ProviderHealthResult.message` already follow.
 */
export interface ProviderSendOutcome {
  readonly status: ProviderSendOutcomeStatus;
  readonly providerMessageId?: string;
  readonly retryable: boolean;
  readonly safeReason?: string;
}

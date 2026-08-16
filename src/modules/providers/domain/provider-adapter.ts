import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { OAuthOperations } from "./oauth-operations.js";
import type { ProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderConnectionValidationResult } from "./provider-connection-validation.js";
import type { ProviderCredential } from "./provider-credential.js";
import type { ProviderHealthResult } from "./provider-health.js";
import type { ProviderSendOutcome, SendMessageCommand } from "./send-message.js";

/**
 * Whether *this deployment* has the app-level configuration an adapter
 * needs to attempt real operations at all (e.g. an OAuth client id/secret
 * present in the environment) — independent of whether any particular
 * mailbox has a working credential. No Stage 5 adapter has this wired up,
 * so every adapter reports `NOT_CONFIGURED` unconditionally.
 */
export const PROVIDER_CONFIGURATION_STATUSES = ["CONFIGURED", "NOT_CONFIGURED"] as const;
export type ProviderConfigurationStatus = (typeof PROVIDER_CONFIGURATION_STATUSES)[number];

export interface ProviderMailboxIdentity {
  readonly emailAddress: string;
  readonly displayName?: string;
}

/**
 * The contract every provider integration implements. Deliberately excludes
 * `receiveMessages` for now — Stage 5 is architecture only for that
 * direction (see module README); adding it speculatively before any
 * conversation engine exists to call it would be exactly the "force
 * providers to implement functionality they cannot support" trap section 3
 * of the Stage 5 spec warns against. `sendMessage` joined in Stage 9, once
 * `warmup` had a real reason to call it.
 *
 * Every method here must be safe to call with no real provider connection
 * available — that's the normal state for all three adapters right now.
 * None of them may fabricate success.
 */
export interface ProviderAdapter {
  readonly providerType: MailboxProviderType;

  /** Static capability declaration for this provider type — never varies by mailbox or configuration. */
  getCapabilities(): ProviderCapabilities;

  /** Whether this deployment is configured to attempt real operations for this provider type at all. */
  getConfigurationStatus(): ProviderConfigurationStatus;

  /**
   * Attempts to validate a mailbox's connection. `credential` is `undefined`
   * when the mailbox has none configured yet — the adapter decides what
   * that means (normally `NOT_CONFIGURED`), not the caller.
   */
  validateConnection(credential: ProviderCredential | undefined): Promise<ProviderConnectionValidationResult>;

  /** Resolves the mailbox's real identity as the provider sees it. Requires a real connection — throws `ProviderError` in Stage 5. */
  getMailboxIdentity(credential: ProviderCredential | undefined): Promise<ProviderMailboxIdentity>;

  /** Point-in-time health snapshot. Safe to call with no credential — returns `UNKNOWN`/`UNAUTHENTICATED` rather than throwing. */
  getConnectionHealth(credential: ProviderCredential | undefined): Promise<ProviderHealthResult>;

  /** Present only on adapters that connect via OAuth (Gmail, Microsoft 365) — undefined on SMTP/IMAP. */
  readonly oauth?: OAuthOperations;

  /**
   * Present only on adapters with a real, safe send implementation behind
   * them (Gmail, Microsoft 365 as of Stage 9) — optional for the same
   * reason `oauth` is: `SmtpImapAdapter` has no safe implementation yet
   * (Stage 9 spec section 3: "Do not fake SMTP sending") and simply leaves
   * this `undefined` rather than being forced to implement it. Callers
   * (`warmup/infrastructure/adapter-warmup-send-provider.ts`) check for its
   * presence before calling and treat its absence as
   * `PROVIDER_SEND_UNAVAILABLE`, never a crash.
   *
   * Never throws for a provider-side rejection — every provider outcome,
   * success or failure, is a normal `ProviderSendOutcome` return value.
   * Network/timeout failures where the provider's actual receipt of the
   * request cannot be confirmed resolve to `SEND_UNKNOWN`, never a thrown
   * exception the caller would have to separately catch and reclassify.
   */
  readonly sendMessage?: (credential: ProviderCredential | undefined, command: SendMessageCommand) => Promise<ProviderSendOutcome>;
}

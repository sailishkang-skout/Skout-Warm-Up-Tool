import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderConnectionValidationResult } from "./provider-connection-validation.js";
import type { ProviderCredential } from "./provider-credential.js";
import type { ProviderHealthResult } from "./provider-health.js";

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
 * `sendMessage`/`receiveMessages` for now — Stage 5 is architecture only
 * (see module README); adding those speculatively before any conversation
 * engine exists to call them would be exactly the "force providers to
 * implement functionality they cannot support" trap section 3 of the Stage
 * 5 spec warns against. They join this interface when Stage 9+ needs them.
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
}

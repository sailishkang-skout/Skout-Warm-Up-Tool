/**
 * Static, per-provider-*type* declaration of what the provider can do in
 * principle — never what a specific mailbox currently has working. The
 * warmup engine (later stages) must branch on these flags, never on
 * `provider === "GMAIL"` — see each adapter's `getCapabilities()`.
 *
 * Deliberately this exact set, no more: LABELS/RATE_LIMIT_INFORMATION and
 * similar were considered and dropped as speculative until a real stage
 * needs them (see src/modules/providers/README.md).
 */
export interface ProviderCapabilities {
  /** Can this provider type send mail at all. */
  readonly canSend: boolean;
  /** Can this provider type receive/read mail at all. */
  readonly canReceive: boolean;
  /** Native conversation/thread grouping (e.g. Gmail, Graph) vs. none (raw SMTP/IMAP). */
  readonly supportsThreads: boolean;
  /** Server-side folder/mailbox hierarchy (IMAP, Graph) vs. label-only or none. */
  readonly supportsFolders: boolean;
  /** Connects via OAuth 2.0 rather than a static credential. */
  readonly supportsOAuth: boolean;
  /** Speaks the SMTP protocol directly for sending. */
  readonly supportsSmtp: boolean;
  /** Speaks the IMAP protocol directly for receiving. */
  readonly supportsImap: boolean;
}

import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

/**
 * What a short-lived OAuth state token resolves to. Binds a callback to the
 * exact tenant/mailbox/provider that started the flow — the callback route
 * validates all three against this record rather than trusting anything in
 * the callback's own query string (see Stage 6 spec section 14).
 * `codeVerifier` is PKCE material: not secret on its own without the
 * matching authorization code, but still handled as opaque, never logged.
 */
export interface OAuthStateRecord {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly codeVerifier: string;
}

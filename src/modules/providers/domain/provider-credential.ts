import type { ProviderAccountId } from "../../../shared/types/index.js";

/**
 * Matches `provider_credentials.credential_type` exactly (see
 * migrations/007_create_provider_credentials.sql) — one variant per
 * concrete credential shape a provider adapter can produce, not per
 * `MailboxProviderType`: SMTP/IMAP is one mailbox provider but two distinct
 * credential shapes (send vs. receive can use different accounts/ports).
 */
export const PROVIDER_CREDENTIAL_KINDS = ["GOOGLE_OAUTH", "MICROSOFT_OAUTH", "SMTP", "IMAP"] as const;
export type ProviderCredentialKind = (typeof PROVIDER_CREDENTIAL_KINDS)[number];

/**
 * Opaque on purpose — the boundary a credential crosses (CredentialStore ->
 * ProviderAdapter, never anywhere else — see provider-credential-store.ts)
 * without either side needing to know the other's storage/wire format.
 * `secretData` is genuinely secret (access/refresh tokens, an SMTP
 * password); `expiresAt`, when present, is not — it's when this credential
 * as a whole stops being usable at all (as opposed to an access token
 * within `secretData` needing a routine refresh). Left undefined for
 * credentials that renew indefinitely (e.g. an OAuth grant with a refresh
 * token that doesn't itself expire).
 *
 * Never: logged, included in an API response, stored on `Mailbox` or
 * `ProviderAccount`, or placed in `RequestContext`.
 */
export interface ProviderCredential {
  readonly providerAccountId: ProviderAccountId;
  readonly kind: ProviderCredentialKind;
  readonly secretData: Readonly<Record<string, unknown>>;
  readonly expiresAt?: Date;
}

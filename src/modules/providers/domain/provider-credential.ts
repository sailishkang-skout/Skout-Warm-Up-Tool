import type { ProviderAccountId } from "../../../shared/types/index.js";

export const PROVIDER_CREDENTIAL_KINDS = ["oauth2", "smtp_imap"] as const;
export type ProviderCredentialKind = (typeof PROVIDER_CREDENTIAL_KINDS)[number];

/**
 * Opaque on purpose. Stage 5 defines the *boundary* a credential crosses
 * (CredentialStore -> ProviderAdapter, never anywhere else — see
 * provider-credential-store.ts) without committing to a concrete payload
 * shape, since that shape is decided by whichever OAuth/SMTP-auth
 * implementation lands in a later stage. `secretData` exists so the type is
 * usable end to end today without a placeholder `unknown` at the call site,
 * but nothing in Stage 5 populates it with real material.
 *
 * Never: logged, included in an API response, stored on `Mailbox` or
 * `ProviderAccount`, or placed in `RequestContext`.
 */
export interface ProviderCredential {
  readonly providerAccountId: ProviderAccountId;
  readonly kind: ProviderCredentialKind;
  readonly secretData: Readonly<Record<string, unknown>>;
}

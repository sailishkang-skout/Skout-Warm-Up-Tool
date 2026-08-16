/**
 * A credential's own lifecycle — deliberately separate from
 * `ProviderAccount.status` (the connection's health) and `Mailbox.status`
 * (the mailbox's connection lifecycle). A credential can be ACTIVE while its
 * provider account sits at ERROR (temporarily unreachable), and a mailbox
 * can be DISCONNECTED while its most recent credential is still ACTIVE —
 * see the Stage 6 spec's own example. Only `revokeCredential` moves a row to
 * REVOKED; nothing transitions a row to EXPIRED yet (read-time expiry
 * checking in the credential store covers the same need without a
 * background sweep — see postgres-provider-credential-store.ts).
 */
export const PROVIDER_CREDENTIAL_STATUSES = ["ACTIVE", "EXPIRED", "REVOKED"] as const;
export type ProviderCredentialStatus = (typeof PROVIDER_CREDENTIAL_STATUSES)[number];

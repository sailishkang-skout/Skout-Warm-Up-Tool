import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { TenantId, ProviderAccountId } from "../../../shared/types/index.js";
import type { ProviderAdapter } from "../domain/provider-adapter.js";
import type { ProviderCredential } from "../domain/provider-credential.js";
import type { ProviderCredentialStore } from "./provider-credential-store.js";

// A refresh is attempted once the access token has less than this much
// life left — comfortably longer than a single request/adapter round trip,
// so a credential never goes stale mid-operation.
const REFRESH_BUFFER_MS = 60_000;

/**
 * Token refresh as a provider responsibility (Stage 6 spec section 10):
 * this function only decides *when* to refresh and persists the result —
 * the actual provider-specific token semantics live entirely behind
 * `adapter.oauth.refreshAccessToken`. A credential with no
 * `accessTokenExpiresAt`/`refreshToken` in `secretData` (SMTP/IMAP, or an
 * OAuth grant that never got a refresh token) is returned as-is; there is
 * nothing to refresh.
 *
 * If the refresh token itself is no longer valid, the credential is
 * revoked (not silently retried forever — see spec section 10) and this
 * returns `undefined`, so the caller's normal "no credential" path runs.
 *
 * Originally private to `mailbox/application/mailbox-service.ts` (Stage 6);
 * extracted here in Stage 9 so `warmup/infrastructure/adapter-warmup-send-provider.ts`
 * can reuse the exact same refresh-before-use logic rather than
 * duplicating it — "use the existing OAuth credential infrastructure, do
 * not create another OAuth system" (Stage 9 spec section 9). Behavior is
 * unchanged from the Stage 6 original; only its location and export moved.
 */
export async function resolveFreshCredential(
  tenantId: TenantId,
  providerAccountId: ProviderAccountId,
  adapter: ProviderAdapter,
  credentialStore: ProviderCredentialStore,
  auditRecorder: AuditEventRecorder,
): Promise<ProviderCredential | undefined> {
  const credential = await credentialStore.getCredential(providerAccountId);
  if (!credential || !adapter.oauth) {
    return credential;
  }

  const expiresAtRaw = credential.secretData.accessTokenExpiresAt;
  const refreshToken = credential.secretData.refreshToken;
  if (typeof expiresAtRaw !== "string" || typeof refreshToken !== "string") {
    return credential;
  }

  const expiresAtMs = Date.parse(expiresAtRaw);
  if (Number.isNaN(expiresAtMs) || expiresAtMs - Date.now() > REFRESH_BUFFER_MS) {
    return credential;
  }

  try {
    const refreshed = await adapter.oauth.refreshAccessToken(refreshToken);
    const updated: ProviderCredential = {
      ...credential,
      secretData: {
        ...credential.secretData,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        scope: refreshed.scope,
        accessTokenExpiresAt: refreshed.expiresAt.toISOString(),
      },
    };
    await credentialStore.saveCredential(updated);
    return updated;
  } catch {
    // The refresh token itself is no longer valid — never silently retried
    // forever (Stage 6 spec section 10). Revoking here, rather than leaving
    // a dead credential ACTIVE, means the next connection attempt fails
    // closed instead of repeatedly trying the same broken token.
    await credentialStore.revokeCredential(providerAccountId);
    await auditRecorder.record({
      tenantId,
      eventType: "PROVIDER_CREDENTIAL_REVOKED",
      actorType: "system",
      metadata: { providerAccountId, reason: "refresh_failed" },
    });
    return undefined;
  }
}

import type { EncryptedPayload, EncryptionService } from "../../../shared/crypto/index.js";
import type { Database } from "../../../shared/db/index.js";
import { asProviderAccountId, type ProviderAccountId } from "../../../shared/types/index.js";
import type { ProviderCredentialStore } from "../application/provider-credential-store.js";
import type { ProviderCredential, ProviderCredentialKind } from "../domain/provider-credential.js";

interface ProviderCredentialRow {
  provider_account_id: string;
  credential_type: ProviderCredentialKind;
  encrypted_payload: string;
  expires_at: Date | null;
}

/**
 * The only `ProviderCredentialStore` implementation safe for production —
 * every credential is AES-256-GCM encrypted (see
 * src/shared/crypto/encryption-service.ts) before it reaches Postgres, and
 * `secretData` never appears in a query parameter's log, an error message,
 * or anywhere else in plaintext once this function returns.
 *
 * Only the ACTIVE row for a provider account is ever returned — see
 * migrations/007_create_provider_credentials.sql for why REVOKED/EXPIRED
 * rows are kept rather than deleted.
 */
export function createPostgresProviderCredentialStore(
  database: Database,
  encryption: EncryptionService,
): ProviderCredentialStore {
  return {
    async getCredential(providerAccountId: ProviderAccountId): Promise<ProviderCredential | undefined> {
      const rows = await database.query<ProviderCredentialRow>(
        `SELECT provider_account_id, credential_type, encrypted_payload, expires_at
         FROM provider_credentials
         WHERE provider_account_id = $1 AND status = 'ACTIVE'`,
        [providerAccountId],
      );
      const row = rows[0];
      if (!row) {
        return undefined;
      }

      // A credential past its own expiry is treated as unusable at read
      // time, the same way Stage 4 checks API credential expiry (see
      // src/modules/auth/application/authentication-service.ts) rather than
      // depending on a background sweep to have already flipped its status.
      if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
        return undefined;
      }

      const payload = JSON.parse(row.encrypted_payload) as EncryptedPayload;
      const secretData = JSON.parse(encryption.decrypt(payload)) as Record<string, unknown>;

      return {
        providerAccountId: asProviderAccountId(row.provider_account_id),
        kind: row.credential_type,
        secretData,
        ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      };
    },

    async saveCredential(credential: ProviderCredential): Promise<void> {
      const encrypted = encryption.encrypt(JSON.stringify(credential.secretData));

      await database.withTransaction(async (tx) => {
        // Supersede, never overwrite in place: the previous ACTIVE row (if
        // any) becomes REVOKED so `provider_credentials_active_unique` never
        // blocks this insert, and history is preserved rather than lost.
        await tx.query(
          `UPDATE provider_credentials
           SET status = 'REVOKED', revoked_at = now()
           WHERE provider_account_id = $1 AND status = 'ACTIVE'`,
          [credential.providerAccountId],
        );

        await tx.query(
          `INSERT INTO provider_credentials
             (provider_account_id, credential_type, encrypted_payload, encryption_version, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            credential.providerAccountId,
            credential.kind,
            JSON.stringify(encrypted),
            encrypted.version,
            credential.expiresAt ?? null,
          ],
        );
      });
    },

    async revokeCredential(providerAccountId: ProviderAccountId): Promise<void> {
      await database.query(
        `UPDATE provider_credentials
         SET status = 'REVOKED', revoked_at = now()
         WHERE provider_account_id = $1 AND status = 'ACTIVE'`,
        [providerAccountId],
      );
    },
  };
}
